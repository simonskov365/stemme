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
async function setup(token?: string, failSpeech = false) {
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
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(8000);
  page.setDefaultNavigationTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
