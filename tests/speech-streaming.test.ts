import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { SpeechSegments } from "../src/speech-segments.js";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";
const c = () =>
  config({
    GROQ_API_KEY: "mock",
    GROQ_MODEL: "mock",
    SPEECH_ENABLED: "true",
    FISH_API_KEY: "mock",
    FISH_MODEL: "mock",
    FISH_VOICE_ID: "mock",
    DATABASE_PATH: ":memory:",
    LOG_LEVEL: "silent",
  });
async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("Timed out");
}
test("incremental speech waits for complete words/sentences and removes chunked code and Markdown", () => {
  const s = new SpeechSegments();
  assert.deepEqual(s.push("Hel"), []);
  assert.deepEqual(s.push("lo world"), []);
  assert.deepEqual(s.push(". "), ["Hello world."]);
  const rest = [
    ...s.push("```js\nsecret.cod"),
    ...s.push("e();\n``"),
    ...s.push("`\nRead **this**. [The link](https://example.com)."),
    ...s.push("", true),
  ].join(" ");
  assert.equal(rest, "Read this. The link.");
  assert.ok(!rest.includes("secret"));
  const x = new SpeechSegments();
  assert.deepEqual(x.push("Dr. "), []);
  assert.deepEqual(x.push("Smith is here. "), ["Dr. Smith is here."]);
  const unclosed = new SpeechSegments();
  assert.deepEqual(unclosed.push("```code\nnever read this", true), []);
});
test("first speech is available while remaining text is still being generated", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const spoken: string[] = [];
  const f = await buildApp(c(), {
    text: {
      async *stream() {
        yield "First complete sentence. ";
        await gate;
        yield "The rest of the answer.";
      },
    },
    speech: {
      async synthesize(text) {
        spoken.push(text);
        return new Uint8Array([1]);
      },
    },
  });
  try {
    const cid = f.store.createConversation(c().OWNER_ID, "Streaming").id;
    const t = f.engine.start(c().OWNER_ID, cid, {
      requestId: "early",
      message: "Hello",
      text: true,
      speech: true,
    });
    await waitFor(() =>
      f.store.events(t.id).some((e) => e.type === "audio.available"),
    );
    assert.equal(f.store.turn(c().OWNER_ID, t.id).status, "running");
    assert.deepEqual(spoken, ["First complete sentence."]);
    release();
    await f.engine.idle();
    const events = f.store.events(t.id);
    assert.ok(
      events.findIndex((e) => e.type === "audio.available") <
        events.findIndex((e) => e.type === "text.completed"),
    );
    assert.equal(
      spoken.join(" "),
      "First complete sentence. The rest of the answer.",
    );
    const audio = events.filter((e) => e.type === "audio.available");
    assert.deepEqual(
      audio.map((e) => e.data.sequence),
      [0, 1],
    );
    assert.equal(audio[0].data.totalSegments, null);
    assert.equal(
      events.find((e) => e.type === "speech.finished")?.data.totalSegments,
      2,
    );
  } finally {
    release();
    await f.app.close();
  }
});
test("speech failures never stop ongoing text generation", async () => {
  const f = await buildApp(c(), {
    text: {
      async *stream() {
        yield "First sentence. ";
        await delay(30);
        yield "Text continues after speech failure.";
      },
    },
    speech: {
      async synthesize() {
        throw new Error("mock speech outage");
      },
    },
  });
  try {
    const cid = f.store.createConversation(c().OWNER_ID, "Failure").id;
    const t = f.engine.start(c().OWNER_ID, cid, {
      requestId: "failure",
      message: "Hi",
      text: true,
      speech: true,
    });
    await f.engine.idle();
    assert.equal(f.store.turn(c().OWNER_ID, t.id).status, "completed");
    assert.equal(f.store.turn(c().OWNER_ID, t.id).speech_status, "failed");
    assert.match(
      f.store.one("SELECT content FROM messages WHERE id=?", t.response_id)!
        .content,
      /Text continues/,
    );
    assert.equal(
      f.store.events(t.id).filter((e) => e.type === "speech.failed").length,
      1,
    );
  } finally {
    await f.app.close();
  }
});
test("cancelling text generation aborts early queued speech and rejects late audio", async () => {
  let speechStarted = false;
  const f = await buildApp(c(), {
    text: {
      async *stream(_m, signal) {
        yield "Start speaking this. ";
        await delay(10000, undefined, { signal });
        yield "Never.";
      },
    },
    speech: {
      async synthesize(_t, signal) {
        speechStarted = true;
        await delay(10000, undefined, { signal });
        return new Uint8Array([1]);
      },
    },
  });
  try {
    const cid = f.store.createConversation(c().OWNER_ID, "Cancel").id;
    const t = f.engine.start(c().OWNER_ID, cid, {
      requestId: "stop",
      message: "Hi",
      text: true,
      speech: true,
    });
    await waitFor(() => speechStarted);
    f.engine.cancel(c().OWNER_ID, t.id);
    await f.engine.idle();
    assert.equal(f.engine.audio.size, 0);
    assert.equal(f.store.turn(c().OWNER_ID, t.id).status, "cancelled");
    assert.ok(!f.store.events(t.id).some((e) => e.type === "audio.available"));
  } finally {
    await f.app.close();
  }
});
test("a text failure aborts pending speech and invalidates already produced audio", async () => {
  const f = await buildApp(c(), {
    text: {
      async *stream() {
        yield "First sentence. ";
        await delay(40);
        throw new Error("mock broken text stream");
      },
    },
    speech: {
      async synthesize() {
        return new Uint8Array([1]);
      },
    },
  });
  try {
    const cid = f.store.createConversation(c().OWNER_ID, "Partial").id;
    const t = f.engine.start(c().OWNER_ID, cid, {
      requestId: "partial",
      message: "Hi",
      text: true,
      speech: true,
    });
    await f.engine.idle();
    assert.ok(f.store.events(t.id).some((e) => e.type === "audio.available"));
    assert.equal(f.engine.audio.size, 0);
    assert.equal(f.store.turn(c().OWNER_ID, t.id).status, "failed");
    assert.equal(f.store.events(t.id).at(-1)?.type, "turn.failed");
  } finally {
    await f.app.close();
  }
});
