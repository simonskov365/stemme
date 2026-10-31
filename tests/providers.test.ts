import { test } from "node:test";
import assert from "node:assert/strict";
import { decode } from "@msgpack/msgpack";
import { config } from "../src/config.js";
import { GroqText } from "../src/providers/groq.js";
import { FishSpeech } from "../src/providers/fish.js";
const c = config({
  GROQ_API_KEY: "mock-groq-secret",
  GROQ_MODEL: "chosen-text-model",
  SPEECH_ENABLED: "true",
  FISH_API_KEY: "mock-fish-secret",
  FISH_MODEL: "chosen-speech-model",
  FISH_VOICE_ID: "voice123",
});
const collect = async (p: GroqText, signal = new AbortController().signal) => {
  let result = "";
  for await (const t of p.stream([{ role: "user", content: "Hi" }], signal))
    result += t;
  return result;
};
const streamResponse = (reason = "stop") =>
  new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello" }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
test("Groq official SDK sends configurable model, completion limit, streams response", async () => {
  const p = new GroqText(c, async (_url, init) => {
    const b = JSON.parse(init!.body as string);
    assert.equal(b.model, c.GROQ_MODEL);
    assert.equal(b.max_completion_tokens, c.OUTPUT_TOKENS);
    assert.equal(b.stream, true);
    assert.ok(init?.signal);
    return streamResponse();
  });
  assert.equal(await collect(p), "Hello");
});
test("explicit pre-stream rate limit retries are bounded", async () => {
  let calls = 0;
  const p = new GroqText(c, async () => {
    calls++;
    return new Response('{"error":{"message":"rate limit"}}', {
      status: 429,
      headers: { "retry-after": "0", "content-type": "application/json" },
    });
  });
  await assert.rejects(collect(p), (e: any) => e.code === "RATE_LIMITED");
  assert.equal(calls, 3);
});
test("ambiguous network failures and 5xx are never retried", async () => {
  for (const fail of [
    async () => {
      throw new Error("api_key=should-not-leak");
    },
    async () => new Response("private diagnostics", { status: 503 }),
  ]) {
    let calls = 0;
    const p = new GroqText(c, async () => {
      calls++;
      return fail();
    });
    await assert.rejects(
      collect(p),
      (e: any) =>
        e.code === "TEXT_PROVIDER_ERROR" &&
        !e.message.includes("should-not-leak"),
    );
    assert.equal(calls, 1);
  }
});
test("truncated stream and output limit do not falsely complete or retry", async () => {
  let calls = 0;
  const p = new GroqText(c, async () => {
    calls++;
    return streamResponse("length");
  });
  await assert.rejects(collect(p), (e: any) => e.code === "OUTPUT_LIMIT");
  assert.equal(calls, 1);
  const truncated = new GroqText(
    c,
    async () =>
      new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', {
        headers: { "Content-Type": "text/event-stream" },
      }),
  );
  await assert.rejects(
    collect(truncated),
    (e: any) => e.code === "TEXT_INTERRUPTED",
  );
});
test("Fish uses official MessagePack body, model header, reference_id and MP3 bytes", async () => {
  const p = new FishSpeech(c, async (url, init) => {
    assert.equal(url, "https://api.fish.audio/v1/tts");
    const headers = init!.headers as Record<string, string>;
    assert.equal(headers.model, c.FISH_MODEL);
    assert.equal(headers["Content-Type"], "application/msgpack");
    const b = decode(init!.body as Uint8Array) as any;
    assert.equal(b.reference_id, c.FISH_VOICE_ID);
    assert.equal(b.format, "mp3");
    assert.equal(b.text, "Hello.");
    return new Response(new Uint8Array([73, 68, 51]));
  });
  assert.deepEqual(
    [...(await p.synthesize("Hello.", new AbortController().signal))],
    [73, 68, 51],
  );
});
test("Fish outages fail independently and are not retried", async () => {
  let calls = 0;
  const p = new FishSpeech(c, async () => {
    calls++;
    return new Response("secret upstream details", { status: 429 });
  });
  await assert.rejects(
    p.synthesize("Hello", new AbortController().signal),
    (e: any) =>
      e.code === "SPEECH_PROVIDER_ERROR" && !e.message.includes("secret"),
  );
  assert.equal(calls, 1);
});
