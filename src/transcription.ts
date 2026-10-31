import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { AppError } from "./errors.js";
export interface TranscriptionProvider {
  transcribe(
    audio: Buffer,
    type: string,
    language: string | undefined,
    signal: AbortSignal,
  ): Promise<string>;
}
const extensions: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "mp4",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/mpeg": "mp3",
};
export class GroqTranscription implements TranscriptionProvider {
  constructor(
    private c: Config,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async transcribe(
    audio: Buffer,
    type: string,
    language: string | undefined,
    signal: AbortSignal,
  ) {
    if (!this.c.GROQ_API_KEY)
      throw new AppError(
        "TRANSCRIPTION_NOT_CONFIGURED",
        "Configure a Groq API key for microphone transcription",
        503,
      );
    const form = new FormData();
    form.set(
      "file",
      new Blob([Uint8Array.from(audio)], { type }),
      `utterance.${extensions[type]}`,
    );
    form.set("model", this.c.GROQ_TRANSCRIPTION_MODEL);
    form.set("response_format", "json");
    if (language) form.set("language", language);
    try {
      const r = await this.fetchImpl(
        "https://api.groq.com/openai/v1/audio/transcriptions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${this.c.GROQ_API_KEY}` },
          body: form,
          signal,
        },
      );
      if (!r.ok) {
        await r.body?.cancel();
        throw new AppError(
          r.status === 429
            ? "RATE_LIMITED"
            : r.status === 401 || r.status === 403
              ? "PROVIDER_AUTH"
              : "TRANSCRIPTION_PROVIDER_ERROR",
          "Audio transcription failed; check model access, quota and provider status",
          502,
        );
      }
      const data = (await r.json()) as { text?: unknown };
      if (typeof data.text !== "string" || data.text.length > 12000)
        throw new AppError(
          "TRANSCRIPTION_PROVIDER_ERROR",
          "Invalid transcription response",
          502,
        );
      return data.text.trim();
    } catch (e) {
      if (e instanceof AppError) throw e;
      if (signal.aborted)
        throw new AppError(
          "TRANSCRIPTION_CANCELLED",
          "Transcription was cancelled or timed out",
          408,
        );
      throw new AppError(
        "TRANSCRIPTION_PROVIDER_ERROR",
        "Could not reach the transcription service",
        502,
      );
    }
  }
}
export function validateAudio(audio: Buffer, type: string) {
  const signature =
    type === "audio/webm"
      ? audio.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
      : type === "audio/mp4"
        ? audio.toString("ascii", 4, 8) === "ftyp"
        : type === "audio/ogg"
          ? audio.toString("ascii", 0, 4) === "OggS"
          : type === "audio/wav"
            ? audio.toString("ascii", 0, 4) === "RIFF" &&
              audio.toString("ascii", 8, 12) === "WAVE"
            : type === "audio/mpeg" &&
              (audio.toString("ascii", 0, 3) === "ID3" ||
                (audio[0] === 255 && (audio[1] & 224) === 224));
  if (!extensions[type] || audio.length < 16 || !signature)
    throw new AppError(
      "INVALID_AUDIO",
      "Unsupported or invalid audio recording",
      415,
    );
}
export class Transcriptions {
  private requests = new Map<
    string,
    {
      hash: string;
      expires: number;
      result: Promise<{ text: string; requestId: string }>;
      running: boolean;
    }
  >();
  constructor(
    private c: Config,
    private provider: TranscriptionProvider,
  ) {}
  run(
    owner: string,
    requestId: string,
    audio: Buffer,
    type: string,
    language: string | undefined,
    signal: AbortSignal,
  ) {
    validateAudio(audio, type);
    if (audio.length > this.c.TRANSCRIPTION_MAX_BYTES)
      throw new AppError("AUDIO_LIMIT", "Recording is too large", 413);
    for (const [key, item] of this.requests)
      if (!item.running && item.expires < Date.now()) this.requests.delete(key);
    const key = owner + ":" + requestId,
      hash = createHash("sha256")
        .update(type + "\0" + (language ?? "") + "\0")
        .update(audio)
        .digest("hex");
    const old = this.requests.get(key);
    if (old) {
      if (old.hash !== hash)
        throw new AppError(
          "IDEMPOTENCY_CONFLICT",
          "Transcription request id has different audio",
          409,
        );
      return old.result;
    }
    if (
      this.requests.size >= 256 ||
      [...this.requests.values()].filter((r) => r.running).length >= 2
    )
      throw new AppError(
        "TRANSCRIPTION_BUSY",
        "Too many pending transcription requests",
        429,
      );
    const item = {
      hash,
      expires: Date.now() + 30 * 60 * 1000,
      running: true,
      result: Promise.resolve({ text: "", requestId }),
    };
    item.result = this.provider
      .transcribe(
        audio,
        type,
        language,
        AbortSignal.any([
          signal,
          AbortSignal.timeout(this.c.REQUEST_TIMEOUT_MS),
        ]),
      )
      .then((text) => {
        if (!text.trim())
          throw new AppError(
            "NO_SPEECH",
            "No speech was recognized. Please try again.",
            422,
          );
        return { text, requestId };
      })
      .finally(() => {
        item.running = false;
      });
    this.requests.set(key, item);
    return item.result;
  }
}
