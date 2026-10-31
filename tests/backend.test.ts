import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { config } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { Store } from "../src/store.js";
import { context, sentences, speechText, cost } from "../src/context.js";
import { AppError } from "../src/errors.js";
import type { TextProvider, SpeechProvider } from "../src/providers/types.js";
const c = () =>
  config({
    GROQ_API_KEY: "test-only",
    GROQ_MODEL: "mock",
    SPEECH_ENABLED: "true",
    FISH_API_KEY: "test-fish",
    FISH_MODEL: "mock",
    FISH_VOICE_ID: "mock",
    DATABASE_PATH: ":memory:",
    LOG_LEVEL: "silent",
  });
const ok: TextProvider = {
  async *stream() {
    yield "Hello. ";
    yield "**World**!";
  },
};
const audio: SpeechProvider = {
  async synthesize() {
    return new Uint8Array([73, 68, 51, 1]);
  },
};
async function fixture(text = ok, speech = audio) {
  return buildApp(c(), { text, speech });
}
async function conversation(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await f.app.inject({
      method: "POST",
      url: "/v1/conversations",
      payload: { title: "Test" },
    })
  ).json().id as string;
}
const send = (
  f: Awaited<ReturnType<typeof fixture>>,
  cid: string,
  requestId = "req1",
  speech = false,
) =>
  f.app.inject({
    method: "POST",
    url: `/v1/conversations/${cid}/turns`,
    payload: { requestId, message: "Hi", speech },
  });
async function until(fn: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (fn()) return;
    await delay(5);
  }
  assert.fail("Timed out waiting for state");
}

test("SQLite migrations, persistent history, startup interruption and ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "stemme-"));
  const path = join(dir, "db.sqlite");
  try {
    let s = new Store(path);
    const cid = s.createConversation("alice", "One").id;
    assert.throws(() => s.conversation("bob", cid), /not found/);
    s.run(
      "INSERT INTO turns VALUES('t',?,'alice','k','h','r','running','running','now')",
      cid,
    );
    s.run(
      "INSERT INTO messages VALUES('r',?,'t','alice','assistant','partial','running','now')",
      cid,
    );
    s.close();
    s = new Store(path);
    assert.equal(s.conversation("alice", cid).title, "One");
    assert.equal(s.turn("alice", "t").status, "interrupted");
    assert.equal(
      s.one("SELECT * FROM messages WHERE id='r'")?.content,
      "partial",
    );
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("stream success, persisted deltas, ordered audio and idempotent requests", async () => {
  const f = await fixture();
  try {
    const cid = await conversation(f),
      r = await send(f, cid, "one", true);
    assert.equal(r.statusCode, 202);
    const turn = r.json();
    await f.engine.idle();
    const events = f.store.events(turn.turnId);
    assert.deepEqual(
      events.filter((e) => e.type === "text.updated").map((e) => e.data.delta),
      ["Hello. ", "**World**!"],
    );
    assert.equal(events.at(-1)?.type, "turn.completed");
    const a = events.find((e) => e.type === "audio.available")!;
    assert.equal(a.data.sequence, 0);
    assert.ok(a.data.speechId);
    assert.equal(
      (await f.app.inject(a.data.url)).headers["content-type"],
      "audio/mpeg",
    );
    const repeat = await send(f, cid, "one", true);
    assert.equal(repeat.json().turnId, turn.turnId);
    assert.equal(f.store.all("SELECT * FROM messages").length, 2);
    const conflict = await f.app.inject({
      method: "POST",
      url: `/v1/conversations/${cid}/turns`,
      payload: { requestId: "one", message: "different", speech: true },
    });
    assert.equal(conflict.statusCode, 409);
    assert.throws(() => f.engine.cancel("other", turn.turnId), /not found/);
    await f.app.inject({
      method: "POST",
      url: `/v1/turns/${turn.turnId}/cancel`,
    });
    assert.equal((await f.app.inject(a.data.url)).statusCode, 404);
  } finally {
    await f.app.close();
  }
});
test("cancellation persists partial text, ignores late speech and invalidates audio", async () => {
  let started = false;
  const speech: SpeechProvider = {
    async synthesize(_text, signal) {
      started = true;
      await delay(10000, undefined, { signal });
      return new Uint8Array([1]);
    },
  };
  const f = await fixture(ok, speech);
  try {
    const cid = await conversation(f);
    const r = (await send(f, cid, "a", true)).json();
    await until(() => started);
    const stop = await f.app.inject({
      method: "POST",
      url: `/v1/turns/${r.turnId}/cancel`,
    });
    assert.equal(stop.statusCode, 200);
    await f.engine.idle();
    assert.equal(f.store.turn(c().OWNER_ID, r.turnId).status, "completed");
    assert.equal(
      f.store.turn(c().OWNER_ID, r.turnId).speech_status,
      "cancelled",
    );
    assert.equal(f.engine.audio.size, 0);
    assert.equal(f.store.events(r.turnId).at(-1)?.type, "turn.cancelled");
  } finally {
    await f.app.close();
  }
});
test("new message interrupts old text without mixing responses", async () => {
  let calls = 0;
  const provider: TextProvider = {
    async *stream(_m, signal) {
      calls++;
      yield calls === 1 ? "partial" : "new";
      if (calls === 1) await delay(10000, undefined, { signal });
    },
  };
  const f = await fixture(provider);
  try {
    const cid = await conversation(f),
      first = (await send(f, cid, "first")).json();
    await until(() =>
      f.store.events(first.turnId).some((e) => e.type === "text.updated"),
    );
    const second = (await send(f, cid, "second")).json();
    await f.engine.idle();
    assert.notEqual(first.responseId, second.responseId);
    assert.equal(
      f.store.turn(c().OWNER_ID, first.turnId).status,
      "interrupted",
    );
    assert.equal(
      f.store.one("SELECT content FROM messages WHERE id=?", first.responseId)
        ?.content,
      "partial",
    );
    assert.equal(
      f.store.one("SELECT content FROM messages WHERE id=?", second.responseId)
        ?.content,
      "new",
    );
  } finally {
    await f.app.close();
  }
});
test("speech failures preserve completed text and do not report a text failure", async () => {
  const f = await fixture(ok, {
    async synthesize() {
      throw new Error("secret-api-key-do-not-expose");
    },
  });
  try {
    const cid = await conversation(f),
      r = (await send(f, cid, "a", true)).json();
    await f.engine.idle();
    assert.equal(f.store.turn(c().OWNER_ID, r.turnId).status, "completed");
    assert.equal(f.store.turn(c().OWNER_ID, r.turnId).speech_status, "failed");
    const events = f.store.events(r.turnId);
    assert.ok(events.some((e) => e.type === "speech.failed"));
    assert.equal(events.at(-1)?.type, "turn.completed");
    assert.ok(!JSON.stringify(events).includes("secret-api-key"));
  } finally {
    await f.app.close();
  }
});
test("provider errors save partial response and redact raw error details", async () => {
  const f = await fixture({
    async *stream() {
      yield "partial";
      throw new Error("gsk_SECRET_VALUE");
    },
  });
  try {
    const cid = await conversation(f),
      r = (await send(f, cid)).json();
    await f.engine.idle();
    assert.equal(f.store.turn(c().OWNER_ID, r.turnId).status, "failed");
    assert.equal(
      f.store.one("SELECT content FROM messages WHERE id=?", r.responseId)
        ?.content,
      "partial",
    );
    assert.ok(
      !JSON.stringify(f.store.events(r.turnId)).includes("gsk_SECRET_VALUE"),
    );
  } finally {
    await f.app.close();
  }
});
test("missing credentials and invalid config fail usefully without secret values", async () => {
  assert.throws(() => config({ GROQ_API_KEY: "secret-value" }), /both/);
  assert.throws(() => config({ HOST: "0.0.0.0" }), /API_TOKEN/);
  assert.throws(() => config({ SPEECH_ENABLED: "true" }), /Speech requires/);
  const f = await buildApp(
    config({ DATABASE_PATH: ":memory:", LOG_LEVEL: "silent" }),
  );
  try {
    const cid = await conversation(f);
    const r = await send(f, cid);
    assert.equal(r.statusCode, 503);
    assert.equal(r.json().error.code, "TEXT_NOT_CONFIGURED");
    assert.ok(r.json().error.requestId);
    assert.equal(f.store.all("SELECT * FROM turns").length, 0);
  } finally {
    await f.app.close();
  }
});
test("memory needs explicit approval, is opt-in, editable and deletable", async () => {
  const f = await fixture();
  try {
    const cid = await conversation(f);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/memories",
          payload: { content: "Likes tea", source: "user" },
        })
      ).statusCode,
      400,
    );
    const r = await f.app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: { content: "Likes tea", source: "user request", approved: true },
    });
    assert.equal(r.statusCode, 201);
    const mid = r.json().id;
    assert.ok(
      !JSON.stringify(
        context(f.store, c(), c().OWNER_ID, cid, "system"),
      ).includes("Likes tea"),
    );
    await f.app.inject({
      method: "PATCH",
      url: `/v1/conversations/${cid}`,
      payload: { memoryEnabled: true },
    });
    assert.ok(
      JSON.stringify(
        context(f.store, c(), c().OWNER_ID, cid, "system"),
      ).includes("Likes tea"),
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/memories",
          payload: {
            content: "API key=secret",
            source: "user",
            approved: true,
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (await f.app.inject({ method: "DELETE", url: `/v1/memories/${mid}` }))
        .statusCode,
      204,
    );
    assert.equal((await f.app.inject("/v1/memories")).json().items.length, 0);
  } finally {
    await f.app.close();
  }
});
test("tool arguments, exact approval, ownership and at-most-once execution", async () => {
  const f = await fixture();
  try {
    let count = 0;
    f.tools.register({
      name: "example-write",
      description: "test only",
      schema: z.object({ value: z.number() }).strict(),
      timeout: 1000,
      kind: "state-changing",
      handler: async () => ({ count: ++count }),
    });
    // Test-only registry enablement; production has only the read-only clock tool.
    (f.tools as any).enabled.push("example-write");
    assert.throws(
      () => f.tools.propose("alice", "example-write", { value: "bad" }, "a"),
      /schema/,
    );
    const a = f.tools.propose("alice", "example-write", { value: 1 }, "a");
    await assert.rejects(f.tools.execute("alice", a.id), /approval/);
    assert.throws(
      () => f.tools.approve("bob", a.id, a.fingerprint),
      /not found/,
    );
    assert.throws(() => f.tools.approve("alice", a.id, "wrong"), /exact/);
    f.tools.approve("alice", a.id, a.fingerprint);
    await Promise.all([
      f.tools.execute("alice", a.id),
      f.tools.execute("alice", a.id),
    ]);
    assert.equal(count, 1);
    assert.throws(
      () => f.tools.propose("alice", "example-write", { value: 2 }, "a"),
      /different/,
    );
  } finally {
    await f.app.close();
  }
});
test("speech segmentation preserves word order and strips code / markdown", () => {
  const clean = speechText(
    "# Title\nHello **world**. [Link](https://example.com).\n```js\nSECRET CODE\n```\nNext sentence!",
  );
  assert.ok(!clean.includes("SECRET"));
  assert.ok(!clean.includes("**"));
  assert.ok(!clean.includes("https"));
  const text = Array.from({ length: 100 }, (_, i) => `Sentence ${i}.`).join(
    " ",
  );
  const segments = sentences(text, 100);
  assert.ok(segments.length > 1);
  assert.equal(segments.join(" "), text);
  assert.ok(segments.every((s) => s.length <= 100));
});
test("multi-segment audio sequential and speech-only retry is deduplicated", async () => {
  let calls = 0;
  const f = await fixture(
    {
      async *stream() {
        yield Array.from(
          { length: 60 },
          (_, i) => `Sentence number ${i}.`,
        ).join(" ");
      },
    },
    {
      async synthesize() {
        calls++;
        return new Uint8Array([1]);
      },
    },
  );
  try {
    const cid = await conversation(f),
      r = (await send(f, cid, "s", true)).json();
    await f.engine.idle();
    const ev = f.store
      .events(r.turnId)
      .filter((e) => e.type === "audio.available");
    assert.ok(ev.length > 1);
    assert.deepEqual(
      ev.map((e) => e.data.sequence),
      ev.map((_, i) => i),
    );
    const url = `/v1/turns/${r.turnId}/speech`;
    await f.app.inject({
      method: "POST",
      url,
      payload: { requestId: "speech1" },
    });
    await f.engine.idle();
    const before = calls;
    await f.app.inject({
      method: "POST",
      url,
      payload: { requestId: "speech1" },
    });
    await f.engine.idle();
    assert.equal(calls, before);
  } finally {
    await f.app.close();
  }
});
test("API origin, host, auth, body-size and ownership checks", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.app.inject({
          url: "/v1/health",
          headers: { origin: "https://evil.test" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/v1/health",
          headers: { host: "evil.test" },
        })
      ).statusCode,
      403,
    );
    const other = f.store.createConversation("other", "private");
    assert.equal(
      (await f.app.inject(`/v1/conversations/${other.id}/messages`)).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/v1/conversations",
          payload: { title: "a".repeat(70000) },
        })
      ).statusCode,
      413,
    );
  } finally {
    await f.app.close();
  }
  const secured = await buildApp(
    { ...c(), API_TOKEN: "a".repeat(32) },
    { text: ok, speech: audio },
  );
  try {
    assert.equal((await secured.app.inject("/v1/health")).statusCode, 401);
    assert.equal(
      (
        await secured.app.inject({
          url: "/v1/health",
          headers: { authorization: "Bearer " + "a".repeat(32) },
        })
      ).statusCode,
      200,
    );
  } finally {
    await secured.app.close();
  }
});
test("conversation deletion cascades messages, turns, summaries, events and audio but retains approved memories", async () => {
  const f = await fixture();
  try {
    const cid = await conversation(f);
    await send(f, cid, "d", true);
    await f.engine.idle();
    await f.app.inject({
      method: "POST",
      url: "/v1/memories",
      payload: {
        content: "Keep this",
        source: "explicit user approval",
        approved: true,
      },
    });
    assert.equal(
      (
        await f.app.inject({
          method: "DELETE",
          url: `/v1/conversations/${cid}`,
        })
      ).statusCode,
      204,
    );
    for (const table of ["messages", "turns", "summaries", "events"])
      assert.equal(f.store.all(`SELECT * FROM ${table}`).length, 0);
    assert.equal(f.engine.audio.size, 0);
    assert.equal(f.store.all("SELECT * FROM memories").length, 1);
  } finally {
    await f.app.close();
  }
});
test("context budget creates explicitly derived excerpts and rejects oversized system instructions", async () => {
  const f = await fixture();
  try {
    const cid = await conversation(f);
    for (let i = 0; i < 5; i++) {
      await f.app.inject({
        method: "POST",
        url: `/v1/conversations/${cid}/turns`,
        payload: {
          requestId: "ctx" + i,
          message: "x".repeat(2000),
          text: false,
        },
      });
    }
    const messages = context(f.store, c(), c().OWNER_ID, cid, "system");
    assert.ok(messages.some((m) => m.content.includes("Derived, lossy")));
    assert.ok(
      messages.reduce((sum, m) => sum + cost(m.content), 0) <
        c().CONTEXT_TOKENS - c().OUTPUT_TOKENS,
    );
    assert.throws(
      () => context(f.store, c(), c().OWNER_ID, cid, "x".repeat(10000)),
      /budget/,
    );
  } finally {
    await f.app.close();
  }
});
test("turn deadline aborts provider work and preserves partial text", async () => {
  const configured = { ...c(), REQUEST_TIMEOUT_MS: 100 };
  const f = await buildApp(configured, {
    text: {
      async *stream(_m, signal) {
        yield "saved";
        await delay(10000, undefined, { signal });
      },
    },
    speech: audio,
  });
  try {
    const cid = await conversation(f);
    const r = (await send(f, cid)).json();
    await f.engine.idle();
    assert.equal(f.store.turn(configured.OWNER_ID, r.turnId).status, "failed");
    assert.equal(
      f.store.one("SELECT content FROM messages WHERE id=?", r.responseId)
        ?.content,
      "saved",
    );
    assert.equal(f.store.events(r.turnId).at(-1)?.data.error.code, "TIMEOUT");
  } finally {
    await f.app.close();
  }
});
test("memory and audio ownership cannot be selected by clients", async () => {
  const f = await fixture();
  try {
    const cid = await conversation(f);
    await send(f, cid, "a", true);
    await f.engine.idle();
    const [aid, a] = [...f.engine.audio][0];
    a.owner = "someone-else";
    assert.equal((await f.app.inject(`/v1/audio/${aid}`)).statusCode, 404);
    f.store.run(
      "INSERT INTO memories VALUES('m','someone-else','private','user','now','now')",
    );
    assert.equal((await f.app.inject("/v1/memories")).json().items.length, 0);
    // Non-UUID paths are rejected before lookup; another owner's valid memory also cannot be removed.
    const mid = crypto.randomUUID();
    f.store.run(
      "INSERT INTO memories VALUES(?,?,?,?,?,?)",
      mid,
      "someone-else",
      "private",
      "user",
      "now",
      "now",
    );
    assert.equal(
      (await f.app.inject({ method: "DELETE", url: `/v1/memories/${mid}` }))
        .statusCode,
      404,
    );
  } finally {
    await f.app.close();
  }
});
