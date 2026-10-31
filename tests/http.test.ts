import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { buildApp } from "../src/app.js";
import { config } from "../src/config.js";
test("real HTTP SSE framing, reconnect replay, and client disconnect preserve work", async () => {
  const f = await buildApp(
    config({
      DATABASE_PATH: ":memory:",
      GROQ_API_KEY: "mock",
      GROQ_MODEL: "mock",
      LOG_LEVEL: "silent",
    }),
    {
      text: {
        async *stream() {
          yield "first ";
          await delay(50);
          yield "second";
        },
      },
      speech: {
        async synthesize() {
          return new Uint8Array([1]);
        },
      },
    },
  );
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  const address = f.app.server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const cid = (
      await (
        await fetch(base + "/v1/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).json()
    ).id;
    const turn = await (
      await fetch(`${base}/v1/conversations/${cid}/turns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: "http1", message: "Hi" }),
      })
    ).json();
    const control = new AbortController();
    const response = await fetch(base + turn.eventsUrl, {
      signal: control.signal,
    });
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /event: turn.started/);
    assert.match(first, /responseId/);
    const cursor = Number(first.match(/id: (\d+)/)?.[1]);
    control.abort();
    await reader.cancel().catch(() => {});
    await f.engine.idle();
    assert.equal(f.store.turn("local-user", turn.turnId).status, "completed");
    const replayControl = new AbortController();
    const replay = await fetch(base + turn.eventsUrl, {
      headers: { "Last-Event-ID": String(cursor) },
      signal: replayControl.signal,
    });
    const replayReader = replay.body!.getReader();
    let text = "";
    while (!text.includes("event: turn.completed")) {
      const next = await replayReader.read();
      if (next.done) break;
      text += new TextDecoder().decode(next.value);
    }
    assert.match(text, /event: text.updated/);
    assert.match(text, /event: turn.completed/);
    assert.ok(
      [...text.matchAll(/^id: (\d+)/gm)].every((m) => Number(m[1]) > cursor),
    );
    replayControl.abort();
    await replayReader.cancel().catch(() => {});
  } finally {
    await f.app.close();
  }
});
