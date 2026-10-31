import "groq-sdk/shims/web";
import Groq from "groq-sdk";
import { setTimeout as delay } from "node:timers/promises";
import type { Config } from "../config.js";
import { AppError } from "../errors.js";
import type { ChatMessage, TextProvider } from "./types.js";
export class GroqText implements TextProvider {
  constructor(
    private c: Config,
    private fetchImpl: typeof fetch = fetch,
  ) {}
  async *stream(messages: ChatMessage[], signal: AbortSignal) {
    if (!this.c.GROQ_API_KEY || !this.c.GROQ_MODEL)
      throw new AppError(
        "TEXT_NOT_CONFIGURED",
        "Configure GROQ_API_KEY and GROQ_MODEL",
        503,
      );
    const client = new Groq({
      apiKey: this.c.GROQ_API_KEY,
      fetch: async (url, init) =>
        this.fetchImpl(String(url), init as RequestInit),
      maxRetries: 0,
      timeout: this.c.REQUEST_TIMEOUT_MS,
    });
    // Only an explicit pre-stream 429 is retried. No network/5xx/partial-stream retries.
    for (let attempt = 0; attempt < 3; attempt++) {
      let opened = false;
      try {
        const stream = await client.chat.completions.create(
          {
            model: this.c.GROQ_MODEL,
            messages,
            stream: true,
            max_completion_tokens: this.c.OUTPUT_TOKENS,
          },
          { signal },
        );
        opened = true;
        let finish: string | null = null;
        for await (const chunk of stream) {
          if (signal.aborted) throw signal.reason;
          const choice = chunk.choices[0];
          if (choice?.delta.content) yield choice.delta.content;
          if (choice?.finish_reason) finish = choice.finish_reason;
        }
        if (finish !== "stop")
          throw new AppError(
            finish === "length" ? "OUTPUT_LIMIT" : "TEXT_INTERRUPTED",
            finish === "length"
              ? "Response reached the configured output limit; partial text was saved"
              : "Provider ended without a complete response",
            502,
          );
        return;
      } catch (e) {
        if (signal.aborted) throw signal.reason;
        if (e instanceof AppError) throw e;
        if (
          e instanceof Groq.APIError &&
          e.status === 429 &&
          !opened &&
          attempt < 2
        ) {
          const seconds = Number(e.headers?.["retry-after"] ?? 1);
          await delay(
            Math.min(
              5000,
              Math.max(250, Number.isFinite(seconds) ? seconds * 1000 : 1000),
            ),
            undefined,
            { signal },
          );
          continue;
        }
        const status = e instanceof Groq.APIError ? e.status : undefined;
        throw new AppError(
          status === 429
            ? "RATE_LIMITED"
            : status === 401 || status === 403
              ? "PROVIDER_AUTH"
              : "TEXT_PROVIDER_ERROR",
          "Text provider request failed; check credentials, model access, limits and provider status",
          502,
        );
      }
    }
  }
}
