import { encode } from "@msgpack/msgpack";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import type { SpeechProvider } from "./types.js";
export class FishSpeech implements SpeechProvider {
  constructor(
    private c: Config,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async synthesize(text: string, signal: AbortSignal) {
    if (!this.c.SPEECH_ENABLED)
      throw new AppError("SPEECH_DISABLED", "Speech is disabled", 503);
    const response = await this.fetchImpl("https://api.fish.audio/v1/tts", {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${this.c.FISH_API_KEY}`,
        "Content-Type": "application/msgpack",
        model: this.c.FISH_MODEL!,
      },
      body: Buffer.from(
        encode({
          text,
          reference_id: this.c.FISH_VOICE_ID,
          format: "mp3",
          mp3_bitrate: 128,
          normalize: true,
          latency: "balanced",
        }),
      ),
    });
    if (!response.ok)
      throw new AppError(
        "SPEECH_PROVIDER_ERROR",
        `Speech provider returned HTTP ${response.status}`,
        502,
      );
    // Bounded buffering; each segment is an independent playable MP3.
    const reader = response.body?.getReader();
    if (!reader)
      throw new AppError(
        "EMPTY_AUDIO",
        "Speech provider returned no audio",
        502,
      );
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 8 * 1024 * 1024)
          throw new AppError(
            "AUDIO_LIMIT",
            "Audio segment exceeds size limit",
            502,
          );
        parts.push(value);
      }
    } finally {
      await reader.cancel();
    }
    if (!size)
      throw new AppError(
        "EMPTY_AUDIO",
        "Speech provider returned no audio",
        502,
      );
    return Buffer.concat(parts);
  }
}
