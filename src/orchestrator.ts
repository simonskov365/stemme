import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { AppError, safeError } from "./errors.js";
import { Store, id, now, type Row } from "./store.js";
import { context, speechText, sentences } from "./context.js";
import type { TextProvider, SpeechProvider } from "./providers/types.js";
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Active = {
  controller: AbortController;
  reason?: "cancelled" | "interrupted";
  done: Promise<void>;
};
export class Orchestrator {
  hub = new EventEmitter();
  active = new Map<string, Active>();
  audio = new Map<
    string,
    {
      owner: string;
      turn: string;
      bytes: Uint8Array;
      expires: number;
      responseId: string;
    }
  >();
  private sweep: ReturnType<typeof setInterval>;
  constructor(
    public store: Store,
    public c: Config,
    private text: TextProvider,
    private speech: SpeechProvider,
    private instructions: string,
  ) {
    this.hub.setMaxListeners(1000);
    this.sweep = setInterval(() => {
      for (const [key, a] of this.audio)
        if (a.expires < Date.now()) this.audio.delete(key);
    }, 10000);
    this.sweep.unref();
  }
  emit(t: Row, type: string, extra: Row = {}) {
    const event = this.store.event(t.id, type, {
      conversationId: t.conversation_id,
      turnId: t.id,
      responseId: t.response_id,
      ...extra,
    });
    this.hub.emit(t.id, event);
    return event;
  }
  start(
    owner: string,
    cid: string,
    input: {
      message: string;
      text: boolean;
      speech: boolean;
      requestId: string;
    },
  ) {
    this.store.conversation(owner, cid);
    const hash = fingerprint(input);
    const existing = this.store.one(
      "SELECT * FROM turns WHERE owner=? AND conversation_id=? AND request_key=?",
      owner,
      cid,
      input.requestId,
    );
    if (existing) {
      if (existing.fingerprint !== hash)
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "Request ID was already used for different content",
          409,
        );
      return existing;
    }
    if (!input.text && input.speech)
      throw new AppError(
        "USE_RESPONSE_SPEECH",
        "Use the response speech endpoint when text generation is disabled",
      );
    if (input.text && (!this.c.GROQ_API_KEY || !this.c.GROQ_MODEL))
      throw new AppError(
        "TEXT_NOT_CONFIGURED",
        "Configure GROQ_API_KEY and GROQ_MODEL",
        503,
      );
    if (input.speech && !this.c.SPEECH_ENABLED)
      throw new AppError("SPEECH_DISABLED", "Speech is disabled", 503);
    // Reject an oversized prompt before interrupting the previous response or persisting a turn.
    if (
      Buffer.byteLength(input.message) >
      this.c.CONTEXT_TOKENS - this.c.OUTPUT_TOKENS - 512
    )
      throw new AppError(
        "CONTEXT_LIMIT",
        "Message exceeds configured context budget",
        413,
      );
    for (const t of this.store.all(
      "SELECT * FROM turns WHERE conversation_id=? AND (status='running' OR speech_status='running')",
      cid,
    ))
      this.cancel(owner, t.id, "interrupted");
    const tid = id(),
      rid = id();
    this.store.tx(() => {
      this.store.run(
        "INSERT INTO turns VALUES(?,?,?,?,?,?,?,?,?)",
        tid,
        cid,
        owner,
        input.requestId,
        hash,
        rid,
        input.text ? "running" : "completed",
        input.speech ? "running" : "disabled",
        now(),
      );
      this.store.run(
        "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)",
        id(),
        cid,
        tid,
        owner,
        "user",
        input.message,
        "completed",
        now(),
      );
      if (input.text)
        this.store.run(
          "INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)",
          rid,
          cid,
          tid,
          owner,
          "assistant",
          "",
          "running",
          now(),
        );
    });
    const t = this.store.turn(owner, tid);
    this.emit(t, "turn.started");
    if (!input.text) {
      this.emit(t, "turn.completed", {
        textStatus: "disabled",
        speechStatus: "disabled",
      });
      return t;
    }
    const active: Active = {
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(tid, active);
    active.done = this.run(t, input.speech, active).finally(() => {
      if (this.active.get(tid) === active) this.active.delete(tid);
    });
    return t;
  }
  private async run(t: Row, withSpeech: boolean, active: Active) {
    const timer = setTimeout(
      () =>
        active.controller.abort(new AppError("TIMEOUT", "Turn timed out", 504)),
      this.c.REQUEST_TIMEOUT_MS,
    );
    timer.unref();
    try {
      const messages = context(
        this.store,
        this.c,
        t.owner,
        t.conversation_id,
        this.instructions,
      );
      let content = "";
      for await (const delta of this.text.stream(
        messages,
        active.controller.signal,
      )) {
        active.controller.signal.throwIfAborted();
        content += delta;
        if (Buffer.byteLength(content) > this.c.OUTPUT_TOKENS * 16)
          throw new AppError(
            "OUTPUT_LIMIT",
            "Provider output exceeded the safety limit",
            502,
          );
        this.store.run(
          "UPDATE messages SET content=? WHERE id=?",
          content,
          t.response_id,
        );
        this.emit(t, "text.updated", { delta });
      }
      active.controller.signal.throwIfAborted();
      this.store.run(
        "UPDATE messages SET status='completed' WHERE id=?",
        t.response_id,
      );
      this.store.run("UPDATE turns SET status='completed' WHERE id=?", t.id);
      this.emit(t, "text.completed");
      if (withSpeech) await this.speak(t, content, active.controller.signal);
      active.controller.signal.throwIfAborted();
      this.emit(t, "turn.completed", {
        textStatus: "completed",
        speechStatus: this.store.turn(t.owner, t.id).speech_status,
      });
    } catch (e) {
      if (active.reason) return; // cancel() persists and emits immediately; late provider results are ignored.
      const err = active.controller.signal.aborted
        ? safeError(active.controller.signal.reason)
        : safeError(e);
      const current = this.store.turn(t.owner, t.id);
      if (current.status !== "completed") {
        this.store.run(
          "UPDATE turns SET status='failed',speech_status=CASE WHEN speech_status='running' THEN 'cancelled' ELSE speech_status END WHERE id=?",
          t.id,
        );
        this.store.run(
          "UPDATE messages SET status='failed' WHERE id=?",
          t.response_id,
        );
      } else
        this.store.run(
          "UPDATE turns SET speech_status='failed' WHERE id=?",
          t.id,
        );
      this.emit(t, "turn.failed", {
        error: { code: err.code, message: err.message },
        textStatus: current.status === "completed" ? "completed" : "failed",
      });
    } finally {
      clearTimeout(timer);
    }
  }
  private async speak(t: Row, text: string, signal: AbortSignal) {
    const speechId = id();
    this.emit(t, "speech.batch", { speechId });
    try {
      const segments = sentences(speechText(text));
      for (let sequence = 0; sequence < segments.length; sequence++) {
        const bytes = await this.speech.synthesize(segments[sequence], signal);
        signal.throwIfAborted();
        this.pruneAudio();
        const total = [...this.audio.values()].reduce(
          (sum, a) => sum + a.bytes.length,
          0,
        );
        if (total + bytes.length > 64 * 1024 * 1024)
          throw new AppError(
            "AUDIO_CAPACITY",
            "Transient audio capacity reached",
            503,
          );
        const aid = id(),
          expires = Date.now() + this.c.AUDIO_TTL_SECONDS * 1000;
        this.audio.set(aid, {
          owner: t.owner,
          turn: t.id,
          bytes,
          expires,
          responseId: t.response_id,
        });
        this.emit(t, "audio.available", {
          audioId: aid,
          speechId,
          sequence,
          totalSegments: segments.length,
          url: `/v1/audio/${aid}`,
          contentType: "audio/mpeg",
          expiresAt: new Date(expires).toISOString(),
        });
      }
      this.store.run(
        "UPDATE turns SET speech_status='completed' WHERE id=?",
        t.id,
      );
    } catch (e) {
      if (signal.aborted) throw e;
      this.store.run(
        "UPDATE turns SET speech_status='failed' WHERE id=?",
        t.id,
      );
      const err = safeError(e);
      this.emit(t, "speech.failed", {
        error: { code: err.code, message: err.message },
      });
    }
  }
  speechOnly(owner: string, tid: string, requestId: string) {
    const t = this.store.turn(owner, tid);
    if (t.status !== "completed")
      throw new AppError(
        "RESPONSE_NOT_COMPLETE",
        "Only completed text responses can be spoken",
        409,
      );
    if (!this.c.SPEECH_ENABLED)
      throw new AppError("SPEECH_DISABLED", "Speech is disabled", 503);
    const key = "speech:" + tid + ":" + requestId;
    const prior = this.store.one(
      "SELECT * FROM tool_actions WHERE owner=? AND request_key=?",
      owner,
      key,
    );
    if (prior)
      return {
        turnId: tid,
        responseId: t.response_id,
        requestId,
        status: prior.status,
      };
    if (this.active.has(tid))
      throw new AppError("TURN_BUSY", "Speech is already running", 409);
    const message = this.store.one(
      "SELECT content FROM messages WHERE id=?",
      t.response_id,
    );
    if (!message) throw new AppError("NOT_FOUND", "Response not found", 404);
    this.store.run(
      "INSERT INTO tool_actions VALUES(?,?,?,?,?,?,0,?,?,?)",
      id(),
      owner,
      key,
      fingerprint(key),
      "speech",
      "{}",
      "running",
      null,
      now(),
    );
    this.store.run("UPDATE turns SET speech_status='running' WHERE id=?", tid);
    const active: Active = {
      controller: new AbortController(),
      done: Promise.resolve(),
    };
    this.active.set(tid, active);
    const timer = setTimeout(
      () =>
        active.controller.abort(
          new AppError("TIMEOUT", "Speech timed out", 504),
        ),
      this.c.REQUEST_TIMEOUT_MS,
    );
    timer.unref();
    this.emit(t, "speech.started", { requestId });
    active.done = this.speak(t, message.content, active.controller.signal)
      .then(() => {
        if (!active.reason)
          this.emit(t, "speech.completed", {
            speechStatus: this.store.turn(owner, tid).speech_status,
          });
      })
      .catch(() => {
        if (!active.reason) {
          this.store.run(
            "UPDATE turns SET speech_status='failed' WHERE id=?",
            tid,
          );
          this.emit(t, "speech.failed", {
            error: { code: "TIMEOUT", message: "Speech timed out" },
          });
        }
      })
      .finally(() => {
        clearTimeout(timer);
        this.store.run(
          "UPDATE tool_actions SET status=? WHERE owner=? AND request_key=?",
          this.store.turn(owner, tid).speech_status,
          owner,
          key,
        );
        if (this.active.get(tid) === active) this.active.delete(tid);
      });
    return {
      turnId: tid,
      responseId: t.response_id,
      requestId,
      status: "running",
    };
  }
  cancel(
    owner: string,
    tid: string,
    reason: "cancelled" | "interrupted" = "cancelled",
  ) {
    const t = this.store.turn(owner, tid),
      active = this.active.get(tid);
    if (active) {
      active.reason = reason;
      active.controller.abort(
        new AppError("CANCELLED", "Generation cancelled", 409),
      );
    }
    this.pruneAudio(tid);
    if (t.status === "running" || t.speech_status === "running") {
      this.store.run(
        "UPDATE turns SET status=CASE WHEN status='running' THEN ? ELSE status END,speech_status=CASE WHEN speech_status='running' THEN ? ELSE speech_status END WHERE id=?",
        reason,
        reason,
        tid,
      );
      this.store.run(
        "UPDATE messages SET status=? WHERE turn_id=? AND role='assistant' AND status='running'",
        reason,
        tid,
      );
      this.emit(
        t,
        reason === "interrupted" ? "turn.interrupted" : "turn.cancelled",
      );
    } else this.emit(t, "audio.cancelled");
    return this.store.turn(owner, tid);
  }
  pruneAudio(tid?: string) {
    for (const [key, a] of this.audio)
      if (a.expires < Date.now() || a.turn === tid) this.audio.delete(key);
  }
  async idle() {
    await Promise.all([...this.active.values()].map((a) => a.done));
  }
  async close() {
    for (const [tid] of this.active) {
      const t = this.store.one("SELECT * FROM turns WHERE id=?", tid);
      if (t) this.cancel(t.owner, tid, "interrupted");
    }
    await this.idle();
    clearInterval(this.sweep);
    this.audio.clear();
  }
}
