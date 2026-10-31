import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "../src/config.js";
import { GroqTranscription, Transcriptions } from "../src/transcription.js";
import { buildApp } from "../src/app.js";
import { SpeechGate } from "../public/voice.js";
const c = () =>
  config({
    GROQ_API_KEY: "mock",
    GROQ_MODEL: "mock",
    DATABASE_PATH: ":memory:",
    LOG_LEVEL: "silent",
  });
function wav(size = 100) {
  const b = Buffer.alloc(size);
  b.write("RIFF", 0);
  b.writeUInt32LE(size - 8, 4);
  b.write("WAVE", 8);
  return b;
}
const providers = (transcription: any) => ({
  text: {
    async *stream() {
      yield "Hello";
    },
  },
  speech: {
    async synthesize() {
      return new Uint8Array([1]);
    },
  },
  transcription,
});
test("Groq transcription sends multipart audio and auto-detects language without retries", async () => {
  let calls = 0;
  const p = new GroqTranscription(c(), async (url, init) => {
    calls++;
    assert.equal(url, "https://api.groq.com/openai/v1/audio/transcriptions");
    const form = init!.body as FormData;
    assert.equal(form.get("model"), "whisper-large-v3-turbo");
    assert.equal(form.get("language"), null);
    assert.equal(form.get("response_format"), "json");
    assert.equal((form.get("file") as File).name, "utterance.wav");
    return Response.json({ text: "Hej verden." });
  });
  assert.equal(
    await p.transcribe(
      wav(),
      "audio/wav",
      undefined,
      new AbortController().signal,
    ),
    "Hej verden.",
  );
  assert.equal(calls, 1);
});
test("transcription API accepts bounded audio, deduplicates requests, and rejects changed/invalid input", async () => {
  let calls = 0;
  const f = await buildApp(
    c(),
    providers({
      async transcribe() {
        calls++;
        return "Recognized words";
      },
    }),
  );
  try {
    const id = crypto.randomUUID();
    const headers = { "content-type": "audio/wav", "x-request-id": id };
    const first = await f.app.inject({
      method: "POST",
      url: "/v1/transcriptions",
      headers,
      payload: wav(70000),
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().text, "Recognized words");
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers,
          payload: wav(70000),
        })
      ).statusCode,
      200,
    );
    assert.equal(calls, 1);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers,
          payload: wav(70001),
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: { ...headers, "x-request-id": crypto.randomUUID() },
          payload: Buffer.alloc(50),
        })
      ).statusCode,
      415,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: { "content-type": "audio/wav" },
          payload: wav(),
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: {
            ...headers,
            "x-request-id": crypto.randomUUID(),
            "x-audio-language": "xx",
          },
          payload: wav(),
        })
      ).statusCode,
      400,
    );
    assert.equal(f.store.all("SELECT * FROM messages").length, 0);
    assert.equal(f.store.all("SELECT * FROM conversations").length, 0);
  } finally {
    await f.app.close();
  }
});
test("audio size limits and API authentication are enforced before transcription", async () => {
  let calls = 0;
  const f = await buildApp(
    { ...c(), TRANSCRIPTION_MAX_BYTES: 1024, API_TOKEN: "a".repeat(32) },
    providers({
      async transcribe() {
        calls++;
        return "Hi";
      },
    }),
  );
  try {
    const headers = {
      "content-type": "audio/wav",
      "x-request-id": crypto.randomUUID(),
    };
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers,
          payload: wav(),
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/transcriptions",
          headers: { ...headers, authorization: "Bearer " + "a".repeat(32) },
          payload: wav(2048),
        })
      ).statusCode,
      413,
    );
    assert.equal(calls, 0);
  } finally {
    await f.app.close();
  }
});
test("ambiguous transcription failures are not retried and error payloads stay redacted", async () => {
  for (const status of [401, 429, 503]) {
    let calls = 0;
    const p = new GroqTranscription(c(), async () => {
      calls++;
      return new Response("private raw upstream data", { status });
    });
    await assert.rejects(
      p.transcribe(wav(), "audio/wav", "da", new AbortController().signal),
      (e: any) => !e.message.includes("private"),
    );
    assert.equal(calls, 1);
  }
  let calls = 0;
  const service = new Transcriptions(c(), {
    async transcribe() {
      calls++;
      throw new Error("mock outage");
    },
  });
  const id = crypto.randomUUID();
  await assert.rejects(
    service.run(
      "owner",
      id,
      wav(),
      "audio/wav",
      undefined,
      new AbortController().signal,
    ),
  );
  await assert.rejects(
    service.run(
      "owner",
      id,
      wav(),
      "audio/wav",
      undefined,
      new AbortController().signal,
    ),
  );
  assert.equal(calls, 1);
});
test("transcription cancellation reaches the provider and empty speech is rejected", async () => {
  const controller = new AbortController();
  const service = new Transcriptions(c(), {
    async transcribe(_a, _t, _l, signal) {
      await delay(10000, undefined, { signal });
      return "late";
    },
  });
  const pending = service.run(
    "owner",
    crypto.randomUUID(),
    wav(),
    "audio/wav",
    undefined,
    controller.signal,
  );
  controller.abort();
  await assert.rejects(pending);
  const empty = new Transcriptions(c(), {
    async transcribe() {
      return " ";
    },
  });
  await assert.rejects(
    empty.run(
      "owner",
      crypto.randomUUID(),
      wav(),
      "audio/wav",
      undefined,
      new AbortController().signal,
    ),
    (e: any) => e.code === "NO_SPEECH",
  );
});
test("local speech gate ignores silence/noise, sends after speech pause, and bounds recordings", () => {
  const gate = new SpeechGate();
  gate.reset(0);
  for (let now = 20; now < 1000; now += 20)
    assert.equal(gate.sample(0, now), "continue");
  assert.equal(gate.heard, false);
  for (let now = 1000; now < 1100; now += 20) gate.sample(0.1, now);
  assert.equal(gate.heard, false);
  for (let now = 1100; now < 1400; now += 20) gate.sample(0.1, now);
  assert.equal(gate.heard, true);
  assert.equal(gate.sample(0, 2400), "send");
  gate.reset(0);
  assert.equal(gate.sample(0, 20001), "discard");
  gate.reset(0);
  for (let now = 20; now < 60100; now += 20) {
    const outcome = gate.sample(0.1, now);
    if (now >= 60000) assert.equal(outcome, "send");
  }
});
