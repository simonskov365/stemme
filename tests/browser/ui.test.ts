import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium, type Page } from "playwright-core";
import { config } from "../../src/config.js";
import { buildApp } from "../../src/app.js";
const speechBytes = execFileSync("ffmpeg", [
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "sine=frequency=220:sample_rate=44100",
  "-t",
  "2",
  "-f",
  "mp3",
  "pipe:1",
]);
async function setup(
  token?: string,
  failSpeech = false,
  microphone = false,
  denyMicrophone = false,
  unavailableFeatures = false,
) {
  const f = await buildApp(
    config({
      DATABASE_PATH: ":memory:",
      GROQ_API_KEY: "mock",
      GROQ_MODEL: "mock",
      SPEECH_ENABLED: "true",
      FISH_API_KEY: "mock",
      FISH_MODEL: "mock",
      FISH_VOICE_ID: "mock",
      LOG_LEVEL: "silent",
      ...(token ? { API_TOKEN: token } : {}),
    }),
    {
      text: {
        async *stream(messages, signal) {
          const last = messages.at(-1)?.content ?? "";
          if (last.includes("langsom")) {
            yield "Dette er starten. ";
            await delay(10000, undefined, { signal });
            yield "Dette må aldrig vises.";
          } else {
            yield "Hej! ";
            await delay(60);
            yield "Jeg hjælper dig gerne.";
          }
        },
      },
      transcription: {
        async transcribe() {
          await delay(20);
          return "Hej fra mikrofonen";
        },
      },
      speech: {
        async synthesize(_text, signal) {
          if (failSpeech) throw new Error("Mocked speech failure");
          await delay(60, undefined, { signal });
          return new Uint8Array(speechBytes);
        },
      },
    },
  );
  await f.app.listen({ host: "127.0.0.1", port: 0 });
  const addr = f.app.server.address();
  assert.ok(addr && typeof addr !== "string");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      ...(microphone
        ? [
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
          ]
        : []),
    ],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    ...(microphone ? { permissions: ["microphone"] } : {}),
  });
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (microphone)
    await page.addInitScript(
      ({ deny }) => {
        const original = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (deny) throw new DOMException("Denied by test", "NotAllowedError");
          const stream = await original(constraints);
          (window as any).__testMicStream = stream;
          return stream;
        };
        const starts = new WeakMap<AnalyserNode, number>();
        AnalyserNode.prototype.getFloatTimeDomainData = function (
          samples: Float32Array,
        ) {
          if (!starts.has(this)) starts.set(this, performance.now());
          samples.fill(performance.now() - starts.get(this)! < 700 ? 0.08 : 0);
        };
      },
      { deny: denyMicrophone },
    );
  if (unavailableFeatures)
    await page.route(/\/(voice|orb)\.js(?:\?.*)?$/, (route) =>
      route.fulfill({
        status: 404,
        contentType: "text/plain",
        body: "Feature module unavailable",
      }),
    );
  await page.goto(`http://127.0.0.1:${addr.port}`);
  return {
    ...f,
    browser,
    page,
    errors,
    async close() {
      await browser.close();
      await f.app.close();
      assert.deepEqual(errors, []);
    },
  };
}
async function send(page: Page, text: string) {
  await page.locator("#message-input").fill(text);
  await page.locator("#send").click();
}
async function complete(page: Page) {
  await page.waitForFunction(
    () =>
      document.querySelector(".message.assistant .message-content")
        ?.textContent === "Hej! Jeg hjælper dig gerne.",
  );
  await page.waitForFunction(() =>
    document
      .querySelector(".message.assistant .message-meta")
      ?.textContent?.includes("Læs op"),
  );
}

test("desktop chat, live deltas, speech playback, speech-only replay, history and mobile layout", async () => {
  const f = await setup();
  try {
    await f.page.waitForFunction(() =>
      document
        .querySelector("#connection")
        ?.textContent?.includes("Klar til dig"),
    );
    assert.equal(
      await f.page.locator("h1").innerText(),
      "Plads til dine tanker.",
    );
    assert.ok(
      (await f.page
        .locator("#voice-orb")
        .evaluate((el) => el.getBoundingClientRect().width)) >= 300,
    );
    await f.page.waitForFunction(
      () =>
        Number(
          getComputedStyle(document.querySelector("#voice-orb")!).opacity,
        ) >= 0.99,
    );
    mkdirSync("artifacts", { recursive: true });
    await f.page.screenshot({
      path: "artifacts/chat-desktop.png",
      fullPage: true,
    });
    await f.page.locator("[data-prompt]").first().click();
    assert.ok(
      (await f.page.locator("#message-input").inputValue()).includes(
        "overblik",
      ),
    );
    await f.page.locator(".speech-toggle").click();
    await send(f.page, "Hej med dig");
    await complete(f.page);
    await f.page.waitForFunction(
      () => !document.querySelector("#audio-tray")?.hasAttribute("hidden"),
    );
    await f.page.waitForFunction(
      () => document.documentElement.dataset.assistantState === "speaking",
    );
    assert.equal(
      await f.page
        .locator(".orb-shell")
        .evaluate((el) => getComputedStyle(el).animationName),
      "voice-vibration",
    );
    await f.page.waitForFunction(
      () =>
        Number(
          document
            .querySelector<HTMLElement>("#voice-orb")!
            .style.getPropertyValue("--voice-level"),
        ) > 0,
    );
    assert.equal(f.store.all("SELECT * FROM conversations").length, 1);
    assert.equal(
      f.store.all("SELECT * FROM messages WHERE role='assistant'")[0].status,
      "completed",
    );
    await f.page.locator("#stop-audio").click();
    assert.equal(await f.page.locator("#audio-tray").isVisible(), false);
    await f.page.waitForFunction(
      () => document.documentElement.dataset.assistantState === "idle",
    );
    assert.equal(
      await f.page
        .locator("#voice-orb")
        .evaluate((el) =>
          (el as HTMLElement).style.getPropertyValue("--voice-level"),
        ),
      "0",
    );
    // A second speech-only request must ignore the earlier batch's terminal/replay events.
    await f.page.locator(".message-action").click();
    await f.page.waitForFunction(
      () => !document.querySelector("#audio-tray")?.hasAttribute("hidden"),
    );
    await f.page.locator("#stop-audio").click();
    await f.page.locator("#new-chat").click();
    await f.page.locator(".conversation-item").first().click();
    await complete(f.page);
    assert.equal(await f.page.locator(".message.user").count(), 1);
    assert.equal(await f.page.locator(".message.assistant").count(), 1);
    await f.page.locator("#rename-chat").click();
    await f.page.locator("#confirm-value").fill("Min samtale");
    await f.page.locator("#confirm-submit").click();
    await f.page.waitForFunction(
      () => document.querySelector("#room-name")?.textContent === "Min samtale",
    );
    await f.page.screenshot({
      path: "artifacts/chat-conversation.png",
      fullPage: true,
    });
    await f.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await f.page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    await f.page.locator("#menu-toggle").click();
    await f.page.waitForFunction(() =>
      document.querySelector("#sidebar")?.classList.contains("open"),
    );
    await f.page.locator(".conversation-item").click();
    await f.page.waitForFunction(
      () => !document.querySelector("#sidebar")?.classList.contains("open"),
    );
    await f.page.waitForFunction(
      () =>
        document.querySelector("#sidebar")!.getBoundingClientRect().right <= 1,
    );
    await f.page.screenshot({
      path: "artifacts/chat-mobile.png",
      fullPage: true,
    });
    assert.ok(
      (await f.page
        .locator("#voice-orb")
        .evaluate((el) => el.getBoundingClientRect().width)) >= 160,
    );
    await f.page.emulateMedia({ reducedMotion: "reduce" });
    await f.page.waitForFunction(
      () =>
        document.querySelector("#voice-orb")!.getAnimations({ subtree: true })
          .length === 0,
    );
    assert.equal(
      await f.page
        .locator(".atmosphere")
        .evaluate((el) => el.getAnimations({ subtree: true }).length),
      0,
    );
  } finally {
    await f.close();
  }
});

test("stop cancels generation; new conversation rejects late text and audio", async () => {
  const f = await setup();
  try {
    await send(f.page, "Et langsomt svar, tak");
    await f.page.waitForFunction(() =>
      document
        .querySelector(".message.assistant .message-content")
        ?.textContent?.includes("Dette er starten"),
    );
    assert.equal(
      await f.page.evaluate(
        () => document.documentElement.dataset.assistantState,
      ),
      "thinking",
    );
    await f.page.locator("#stop-generation").click();
    await f.engine.idle();
    assert.equal(f.store.all("SELECT * FROM turns")[0].status, "cancelled");
    await f.page.locator("#new-chat").click();
    await send(f.page, "Et nyt svar");
    await complete(f.page);
    assert.equal(await f.page.locator(".message.assistant").count(), 1);
    assert.ok(
      !(await f.page.locator("#messages").innerText()).includes(
        "Dette er starten",
      ),
    );
    // Hold a previously generated audio download until the user has switched away.
    let audioRequested = false;
    let release!: () => void;
    const wait = new Promise<void>((r) => (release = r));
    await f.page.route("**/v1/audio/*", async (route) => {
      audioRequested = true;
      await wait;
      try {
        await route.continue();
      } catch {}
    });
    await f.page.locator(".speech-toggle").click();
    await send(f.page, "Læs dette op");
    for (let i = 0; i < 100 && !audioRequested; i++) await delay(20);
    assert.equal(audioRequested, true);
    await f.page.locator("#new-chat").click();
    release();
    await delay(150);
    assert.equal(await f.page.locator("#audio-tray").isVisible(), false);
    assert.equal(await f.page.locator("#welcome").isVisible(), true);
  } finally {
    await f.close();
  }
});

test("memory is approved, editable, opt-in and removable in the browser", async () => {
  const f = await setup();
  try {
    await send(f.page, "Hej");
    await complete(f.page);
    await f.page.locator("#open-settings").click();
    await f.page.locator("#memory-content").fill("Jeg foretrækker dansk.");
    await f.page.locator("#memory-form button").click();
    await f.page.waitForFunction(
      () => document.querySelectorAll(".memory-item").length === 1,
    );
    assert.equal(f.store.all("SELECT * FROM memories").length, 1);
    assert.equal(
      f.store.all("SELECT * FROM conversations")[0].memory_enabled,
      0,
    );
    await f.page.locator("#memory-enabled").check();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#settings-feedback")
        ?.textContent?.includes("næste besked"),
    );
    await f.page.locator(".memory-item button").first().click();
    await f.page
      .locator("#confirm-value")
      .fill("Jeg foretrækker korte svar på dansk.");
    await f.page.locator("#confirm-submit").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector(".memory-item p")?.textContent ===
        "Jeg foretrækker korte svar på dansk.",
    );
    await f.page.locator(".memory-item button").last().click();
    await f.page.waitForFunction(
      () => document.querySelectorAll(".memory-item").length === 0,
    );
    assert.equal(f.store.all("SELECT * FROM memories").length, 0);
  } finally {
    await f.close();
  }
});

test("public login shell exposes no provider keys and keeps authenticated API protected", async () => {
  const token = "local-development-test-token-123456";
  const f = await setup(token);
  try {
    await f.page.waitForFunction(() =>
      document.querySelector("#settings-dialog")?.hasAttribute("open"),
    );
    await f.page.locator("#api-token").fill(token);
    await f.page.locator("#token-form button").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#connection")
        ?.textContent?.includes("Klar til dig"),
    );
    await send(f.page, "Hej");
    await complete(f.page);
    assert.equal(
      await f.page.evaluate(() => localStorage.length + sessionStorage.length),
      0,
    );
    const unauth = await f.app.inject("/v1/conversations");
    assert.equal(unauth.statusCode, 401);
    for (const path of ["/", "/app.js", "/style.css", "/stream.js"])
      assert.equal((await f.app.inject(path)).statusCode, 200);
    assert.equal((await f.app.inject("/.env")).statusCode, 401);
  } finally {
    await f.close();
  }
});

test("speech failure leaves completed text readable and shows a clear notice", async () => {
  const f = await setup(undefined, true);
  try {
    await f.page.locator(".speech-toggle").click();
    await send(f.page, "Hej");
    await complete(f.page);
    await f.page.waitForFunction(() =>
      document
        .querySelector("#notice-text")
        ?.textContent?.includes("Du kan stadig læse svaret"),
    );
    assert.equal(
      await f.page.locator(".message.assistant .message-content").innerText(),
      "Hej! Jeg hjælper dig gerne.",
    );
    assert.equal(await f.page.locator("#audio-tray").isVisible(), false);
  } finally {
    await f.close();
  }
});

test("background orb stays visible while a long conversation scrolls over it", async () => {
  const f = await setup();
  try {
    await send(f.page, "Hej");
    await complete(f.page);
    await f.page.waitForFunction(
      () =>
        Number(
          getComputedStyle(document.querySelector("#voice-orb")!).opacity,
        ) >= 0.99,
    );
    const initial = await f.page.locator("#voice-orb").boundingBox();
    assert.ok(initial);
    await f.page.evaluate(() => {
      const messages = document.querySelector("#messages")!;
      for (let i = 0; i < 40; i++) {
        const article = document.createElement("article");
        article.className = "message";
        article.textContent =
          "A long conversation paragraph to verify scrolling. ".repeat(15);
        messages.append(article);
      }
      const workspace = document.querySelector("#workspace")!;
      workspace.scrollTop = workspace.scrollHeight;
    });
    await f.page.waitForFunction(
      () => document.querySelector("#workspace")!.scrollTop > 500,
    );
    const after = await f.page.locator("#voice-orb").boundingBox();
    assert.ok(after);
    assert.ok(Math.abs(initial.y - after.y) < 1);
    assert.ok(after.y > 0 && after.y + after.height < 1000);
    assert.equal(
      await f.page
        .locator(".orb-stage")
        .evaluate((el) => getComputedStyle(el).pointerEvents),
      "none",
    );
  } finally {
    await f.close();
  }
});

test("conversation mode records after consent, transcribes, speaks, and resumes listening", async () => {
  const f = await setup(undefined, false, true);
  try {
    assert.equal(
      await f.page.evaluate(() => Boolean((window as any).__testMicStream)),
      false,
    );
    await f.page.locator("#voice-start").click();
    await f.page.waitForFunction(
      () => document.documentElement.dataset.voicePhase === "listening",
    );
    await f.page.waitForFunction(
      () =>
        document.querySelector(".message.user .message-content")
          ?.textContent === "Hej fra mikrofonen",
      undefined,
      { timeout: 12000 },
    );
    await f.page.waitForFunction(
      () => document.documentElement.dataset.assistantState === "speaking",
    );
    assert.equal(
      await f.page.evaluate(() =>
        (window as any).__testMicStream
          .getAudioTracks()
          .every((t: MediaStreamTrack) => !t.enabled),
      ),
      true,
    );
    await f.page.waitForFunction(
      () => document.documentElement.dataset.voicePhase === "listening",
      undefined,
      { timeout: 12000 },
    );
    assert.equal(
      f.store.all("SELECT * FROM messages WHERE role='user'").length,
      1,
    );
    await f.page.locator("#voice-stop").click();
    assert.equal(await f.page.locator("#voice-bar").isVisible(), false);
    assert.equal(
      await f.page.evaluate(() =>
        (window as any).__testMicStream
          .getTracks()
          .every((t: MediaStreamTrack) => t.readyState === "ended"),
      ),
      true,
    );
  } finally {
    await f.close();
  }
});
test("microphone denial leaves text chat usable and explains the permission", async () => {
  const f = await setup(undefined, false, true, true);
  try {
    await f.page.locator("#voice-start").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#notice-text")
        ?.textContent?.includes("Mikrofonadgang blev afvist"),
    );
    assert.equal(await f.page.locator("#voice-bar").isVisible(), false);
    await send(f.page, "Hej");
    await complete(f.page);
  } finally {
    await f.close();
  }
});
test("interrupting pending transcription discards its late result and releases mic on exit", async () => {
  const f = await setup(undefined, false, true);
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  try {
    let requested = false;
    await f.page.route("**/v1/transcriptions", async (route) => {
      requested = true;
      await gate;
      try {
        await route.fulfill({
          json: {
            text: "This late transcript must never be sent",
            requestId: "mock",
          },
        });
      } catch {}
    });
    await f.page.locator("#voice-start").click();
    for (let i = 0; i < 150 && !requested; i++) await delay(20);
    assert.equal(requested, true);
    await f.page.locator("#voice-interrupt").click();
    release();
    await f.page.waitForFunction(
      () => document.documentElement.dataset.voicePhase === "listening",
    );
    assert.equal(
      f.store.all("SELECT * FROM messages WHERE role='user'").length,
      0,
    );
    await f.page.locator("#voice-stop").click();
    assert.equal(
      await f.page.evaluate(() =>
        (window as any).__testMicStream
          .getTracks()
          .every((t: MediaStreamTrack) => t.readyState === "ended"),
      ),
      true,
    );
  } finally {
    release();
    await f.close();
  }
});

test("text chat and settings stay usable when optional voice/animation modules are missing", async () => {
  const f = await setup(undefined, false, false, false, true);
  try {
    await f.page.waitForFunction(() =>
      document
        .querySelector("#connection")
        ?.textContent?.includes("Klar til dig"),
    );
    await send(f.page, "Hej");
    await complete(f.page);
    await f.page.locator("#open-settings").click();
    assert.equal(await f.page.locator("#settings-dialog").isVisible(), true);
    assert.equal(await f.page.locator("#voice-start").isDisabled(), false);
    await f.page.locator("#close-settings").click();
    await f.page.locator("#voice-start").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#notice-text")
        ?.textContent?.includes("Mikrofonfilen kunne ikke indlæses"),
    );
  } finally {
    await f.close();
  }
});

test("Safari-style suspended audio does not prevent the microphone permission request", async () => {
  const f = await setup(undefined, false, true, true);
  try {
    await f.page.evaluate(() => {
      AudioContext.prototype.resume = function () {
        return new Promise<void>(() => {});
      };
    });
    await f.page.locator("#voice-start").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#notice-text")
        ?.textContent?.includes("Mikrofonadgang blev afvist"),
    );
    assert.equal(await f.page.locator("#voice-bar").isVisible(), false);
  } finally {
    await f.close();
  }
});

test("older backend explains missing microphone support instead of a dead button", async () => {
  const f = await setup();
  try {
    await f.page.route("**/v1/health", (r) =>
      r.fulfill({
        json: {
          status: "ok",
          providers: {
            text: "configured-unverified",
            speech: "configured-unverified",
          },
          transcription: "not-implemented",
        },
      }),
    );
    await f.page.reload();
    await f.page.locator("#voice-start").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#notice-text")
        ?.textContent?.includes("server mangler mikrofonfunktionen"),
    );
    await send(f.page, "Hej");
    await complete(f.page);
  } finally {
    await f.close();
  }
});

test("Nyra text import requires approval, changes assistant name, and can be disabled/deleted", async () => {
  const f = await setup();
  try {
    await f.page.locator("#open-settings").click();
    await f.page.locator("#nyra-file").setInputFiles({
      name: "Nyra-test.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(
        "Nyra – Test\n1. Permanent Core\nNyra identity & personality\nWarm and witty.\n\nConversation style\nBe curious.\n\n2. Continuity Timeline\nA telescope project was discussed.",
      ),
    });
    await f.page.waitForFunction(() =>
      document
        .querySelector("#nyra-source-status")
        ?.textContent?.includes("Nyra-test.txt"),
    );
    assert.equal(f.store.one("SELECT enabled FROM nyra_profiles")?.enabled, 0);
    await f.page.locator("#nyra-enabled").check();
    await f.page.locator("#nyra-save").click();
    await f.page.waitForFunction(() =>
      document
        .querySelector("#nyra-feedback")
        ?.textContent?.includes("næste besked"),
    );
    assert.equal(f.store.one("SELECT enabled FROM nyra_profiles")?.enabled, 1);
    await f.page.locator("#close-settings").click();
    await send(f.page, "Hej Nyra");
    await complete(f.page);
    assert.equal(
      await f.page.locator(".message.assistant .message-role").textContent(),
      "Nyra",
    );
    await f.page.locator("#open-settings").click();
    await f.page.locator("#nyra-delete").click();
    await f.page.locator("#confirm-submit").click();
    await f.page.waitForFunction(
      () =>
        document.querySelector("#nyra-source-status")?.textContent ===
        "Intet dokument forbundet.",
    );
    assert.equal(f.store.all("SELECT * FROM nyra_documents").length, 0);
    assert.equal(f.store.all("SELECT * FROM messages").length, 2);
  } finally {
    await f.close();
  }
});
