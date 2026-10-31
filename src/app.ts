import Fastify, { LogController } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.js";
import { AppError, safeError } from "./errors.js";
import { Store, id, now } from "./store.js";
import { GroqText } from "./providers/groq.js";
import { FishSpeech } from "./providers/fish.js";
import type { TextProvider, SpeechProvider } from "./providers/types.js";
import { Orchestrator } from "./orchestrator.js";
import { Tools } from "./tools.js";
const uuid = z.uuid();
const requestId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[\w-]+$/);
const body = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const r = schema.safeParse(value);
  if (!r.success)
    throw new AppError(
      "VALIDATION_ERROR",
      "Invalid request: " +
        r.error.issues.map((i) => i.path.join(".")).join(", "),
    );
  return r.data;
};
const page = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  after: z.coerce.number().int().nonnegative().default(0),
});
const memory = z
  .object({
    content: z.string().trim().min(1).max(2000),
    source: z.string().trim().min(1).max(300),
    approved: z.literal(true),
  })
  .strict();
function noSecrets(text: string) {
  if (
    /(?:api[_ -]?key|password|secret|bearer|token)\s*[:=]|\b(?:sk-|gsk_)[A-Za-z0-9]{10,}/i.test(
      text,
    )
  )
    throw new AppError(
      "SENSITIVE_MEMORY",
      "Do not store credentials in memory",
    );
}
export async function buildApp(
  c: Config,
  providers?: { text: TextProvider; speech: SpeechProvider },
  database?: Store,
) {
  const app = Fastify({
    bodyLimit: 65536,
    forceCloseConnections: true,
    logger: {
      level: c.LOG_LEVEL,
      redact: ["req.headers.authorization", "req.body", "res.body"],
    },
    logController: new LogController({ disableRequestLogging: true }),
    requestTimeout: c.REQUEST_TIMEOUT_MS + 5000,
    genReqId: () => id(),
  });
  const store = database ?? new Store(c.DATABASE_PATH);
  const instructions = readFileSync(c.SYSTEM_INSTRUCTIONS_FILE, "utf8");
  const engine = new Orchestrator(
    store,
    c,
    providers?.text ?? new GroqText(c),
    providers?.speech ?? new FishSpeech(c),
    instructions,
  );
  const tools = new Tools(
    store,
    c.ENABLED_TOOLS.split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
  const publicFiles = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/stream.js", ["stream.js", "text/javascript; charset=utf-8"]],
    ["/style.css", ["style.css", "text/css; charset=utf-8"]],
    ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ]);
  // Exact, static allowlist. No user-controlled paths or configuration are served.
  for (const [route, [file, type]] of publicFiles) {
    app.get(route, async (_req, reply) =>
      reply
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self' blob:; img-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
        )
        .header("Referrer-Policy", "no-referrer")
        .type(type)
        .send(readFileSync(new URL("../public/" + file, import.meta.url))),
    );
  }
  const origins = c.ALLOWED_ORIGINS.split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: origins,
    methods: ["GET", "POST", "PATCH", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization", "Last-Event-ID"],
  });
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (
      origin &&
      origin !== `${req.protocol}://${req.headers.host}` &&
      !origins.includes(origin)
    )
      throw new AppError(
        "ORIGIN_FORBIDDEN",
        "Frontend origin is not allowed",
        403,
      );
    const uiRequest =
      (req.method === "GET" || req.method === "HEAD") &&
      publicFiles.has(req.url.split("?")[0]);
    if (c.API_TOKEN && !uiRequest) {
      const expected = Buffer.from(`Bearer ${c.API_TOKEN}`),
        actual = Buffer.from(req.headers.authorization ?? "");
      if (
        expected.length !== actual.length ||
        !timingSafeEqual(expected, actual)
      )
        throw new AppError(
          "UNAUTHORIZED",
          "A valid API bearer token is required",
          401,
        );
    } else if (!c.API_TOKEN) {
      const host = (req.headers.host ?? "").replace(/:\d+$/, "");
      if (!["localhost", "127.0.0.1", "[::1]"].includes(host))
        throw new AppError(
          "HOST_FORBIDDEN",
          "Local-only service requires a loopback Host",
          403,
        );
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const native = error as { statusCode?: number };
    const err =
      error instanceof AppError
        ? error
        : native.statusCode && native.statusCode < 500
          ? new AppError(
              native.statusCode === 429 ? "RATE_LIMITED" : "INVALID_REQUEST",
              native.statusCode === 429
                ? "Too many requests"
                : "Invalid request",
              native.statusCode,
            )
          : safeError(error);
    reply.code(err.status).send({
      error: { code: err.code, message: err.message, requestId: req.id },
    });
  });
  const owner = () => c.OWNER_ID;
  const params = (req: { params: unknown }, key: string) => {
    const p = req.params as Record<string, unknown>;
    return body(uuid, p[key]);
  };
  app.get("/v1/health", async () => ({
    status: "ok",
    providers: {
      text: c.GROQ_API_KEY ? "configured-unverified" : "not-configured",
      speech: c.SPEECH_ENABLED ? "configured-unverified" : "disabled",
    },
    transcription: "not-implemented",
  }));
  app.post("/v1/conversations", async (req, reply) => {
    const b = body(
      z
        .object({
          title: z.string().trim().min(1).max(200).default("New conversation"),
        })
        .strict(),
      req.body ?? {},
    );
    reply.code(201);
    return store.createConversation(owner(), b.title);
  });
  app.get("/v1/conversations", async (req) => {
    const q = body(page, req.query);
    return {
      items: store.all(
        "SELECT rowid AS cursor,* FROM conversations WHERE owner=? AND rowid>? ORDER BY rowid LIMIT ?",
        owner(),
        q.after,
        q.limit,
      ),
    };
  });
  app.patch("/v1/conversations/:cid", async (req) => {
    const cid = params(req, "cid");
    store.conversation(owner(), cid);
    const b = body(
      z
        .object({
          title: z.string().trim().min(1).max(200).optional(),
          memoryEnabled: z.boolean().optional(),
        })
        .strict(),
      req.body,
    );
    if (b.title !== undefined)
      store.run("UPDATE conversations SET title=? WHERE id=?", b.title, cid);
    if (b.memoryEnabled !== undefined)
      store.run(
        "UPDATE conversations SET memory_enabled=? WHERE id=?",
        Number(b.memoryEnabled),
        cid,
      );
    return store.conversation(owner(), cid);
  });
  app.delete("/v1/conversations/:cid", async (req, reply) => {
    const cid = params(req, "cid");
    store.conversation(owner(), cid);
    for (const t of store.all(
      "SELECT id FROM turns WHERE conversation_id=?",
      cid,
    )) {
      engine.cancel(owner(), t.id);
    }
    await engine.idle();
    store.run("DELETE FROM conversations WHERE id=?", cid);
    return reply.code(204).send();
  });
  app.get("/v1/conversations/:cid/messages", async (req) => {
    const cid = params(req, "cid");
    store.conversation(owner(), cid);
    const q = body(page, req.query);
    return {
      items: store.all(
        "SELECT rowid AS cursor,* FROM messages WHERE conversation_id=? AND owner=? AND rowid>? ORDER BY rowid LIMIT ?",
        cid,
        owner(),
        q.after,
        q.limit,
      ),
    };
  });
  app.post(
    "/v1/conversations/:cid/turns",
    { config: { rateLimit: { max: 20, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const cid = params(req, "cid");
      const b = body(
        z
          .object({
            requestId,
            message: z.string().trim().min(1).max(32000),
            text: z.boolean().default(true),
            speech: z.boolean().default(false),
          })
          .strict(),
        req.body,
      );
      const t = engine.start(owner(), cid, b);
      reply.code(202);
      return {
        turnId: t.id,
        responseId: t.response_id,
        status: t.status,
        eventsUrl: `/v1/turns/${t.id}/events`,
      };
    },
  );
  app.get("/v1/turns/:tid", async (req) => {
    const t = store.turn(owner(), params(req, "tid"));
    return {
      ...t,
      event_cursor: store.one(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE turn_id=?",
        t.id,
      )!.seq,
      speech_cursor: store.one(
        "SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE turn_id=? AND type='speech.started'",
        t.id,
      )!.seq,
    };
  });
  app.post("/v1/turns/:tid/cancel", async (req) =>
    engine.cancel(owner(), params(req, "tid")),
  );
  app.post(
    "/v1/turns/:tid/speech",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const b = body(z.object({ requestId }).strict(), req.body);
      reply.code(202);
      return engine.speechOnly(owner(), params(req, "tid"), b.requestId);
    },
  );
  app.get("/v1/turns/:tid/events", async (req, reply) => {
    const tid = params(req, "tid");
    store.turn(owner(), tid);
    const q = body(
      z.object({ after: z.coerce.number().int().nonnegative().default(0) }),
      req.query,
    );
    let after = body(
      z.coerce.number().int().nonnegative(),
      req.headers["last-event-id"] ?? q.after,
    );
    // Replay and subscription happen synchronously in the same event-loop turn.
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(req.headers.origin
        ? { "Access-Control-Allow-Origin": req.headers.origin, Vary: "Origin" }
        : {}),
    });
    let closed = false;
    const write = (e: any) => {
      if (closed || e.seq <= after) return;
      after = e.seq;
      if (
        !reply.raw.write(
          `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`,
        )
      )
        cleanup();
    };
    const heartbeat = setInterval(() => {
      if (!closed && !reply.raw.write(": heartbeat\n\n")) cleanup();
    }, 15000);
    heartbeat.unref();
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      engine.hub.off(tid, write);
      reply.raw.end();
    };
    reply.raw.on("close", cleanup);
    engine.hub.on(tid, write);
    for (const event of store.events(tid, after)) write(event);
    // Keep open for separately requested speech; clients close after their terminal event.
    const maxLife = setTimeout(cleanup, 300000);
    maxLife.unref();
    reply.raw.on("close", () => clearTimeout(maxLife));
  });
  app.get("/v1/audio/:aid", async (req, reply) => {
    engine.pruneAudio();
    const a = engine.audio.get(params(req, "aid"));
    if (!a || a.owner !== owner())
      throw new AppError("NOT_FOUND", "Audio expired or not found", 404);
    store.turn(owner(), a.turn);
    return reply.type("audio/mpeg").send(Buffer.from(a.bytes));
  });
  app.get("/v1/memories", async () => ({
    items: store.all(
      "SELECT * FROM memories WHERE owner=? ORDER BY created_at",
      owner(),
    ),
  }));
  app.post("/v1/memories", async (req, reply) => {
    const b = body(memory, req.body);
    noSecrets(b.content);
    noSecrets(b.source);
    const mid = id(),
      time = now();
    store.run(
      "INSERT INTO memories VALUES(?,?,?,?,?,?)",
      mid,
      owner(),
      b.content,
      b.source,
      time,
      time,
    );
    reply.code(201);
    return store.one("SELECT * FROM memories WHERE id=?", mid);
  });
  app.patch("/v1/memories/:mid", async (req) => {
    const mid = params(req, "mid");
    if (
      !store.one("SELECT id FROM memories WHERE id=? AND owner=?", mid, owner())
    )
      throw new AppError("NOT_FOUND", "Memory not found", 404);
    const b = body(memory, req.body);
    noSecrets(b.content);
    noSecrets(b.source);
    store.run(
      "UPDATE memories SET content=?,source=?,updated_at=? WHERE id=? AND owner=?",
      b.content,
      b.source,
      now(),
      mid,
      owner(),
    );
    return store.one("SELECT * FROM memories WHERE id=?", mid);
  });
  app.delete("/v1/memories/:mid", async (req, reply) => {
    const r = store.run(
      "DELETE FROM memories WHERE id=? AND owner=?",
      params(req, "mid"),
      owner(),
    );
    if (!r.changes) throw new AppError("NOT_FOUND", "Memory not found", 404);
    return reply.code(204).send();
  });
  app.get("/v1/tools", async () => ({ items: tools.list() }));
  app.post("/v1/tool-actions", async (req) => {
    const b = body(
      z
        .object({
          name: z.string().max(100),
          args: z.unknown(),
          requestId,
          turnId: uuid.optional(),
        })
        .strict(),
      req.body,
    );
    if (b.turnId) store.turn(owner(), b.turnId);
    const action = tools.propose(owner(), b.name, b.args, b.requestId);
    if (b.turnId)
      engine.emit(store.turn(owner(), b.turnId), "tool.activity", {
        actionId: action.id,
        name: action.name,
        status: action.status,
      });
    return action;
  });
  app.get("/v1/tool-actions/:aid", async (req) =>
    tools.get(owner(), params(req, "aid")),
  );
  app.post("/v1/tool-actions/:aid/approve", async (req) => {
    const b = body(
      z
        .object({
          fingerprint: z.string().length(64),
          approved: z.literal(true),
        })
        .strict(),
      req.body,
    );
    return tools.approve(owner(), params(req, "aid"), b.fingerprint);
  });
  app.post("/v1/tool-actions/:aid/execute", async (req) =>
    tools.execute(owner(), params(req, "aid")),
  );
  app.addHook("onClose", async () => {
    await engine.close();
    store.close();
  });
  return { app, store, engine, tools };
}
