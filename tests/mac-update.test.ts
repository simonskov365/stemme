import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error The Mac helper is a standalone Node ES module, not part of the TypeScript build.
import { copyUpdate } from "../mac/update.mjs";
test("Mac updater preserves credentials, conversations and custom instructions", () => {
  const dir = mkdtempSync(join(tmpdir(), "stemme-update-"));
  try {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "stemme-backend" }),
    );
    writeFileSync(join(dir, "Start.command"), "old");
    writeFileSync(join(dir, ".env"), "private fixture, not a key");
    writeFileSync(join(dir, "assistant.md"), "custom instructions");
    // Data is deliberately outside the updater allowlist.
    const data = join(dir, "data");
    mkdirSync(data);
    writeFileSync(join(data, "stemme.sqlite"), "existing conversation fixture");
    copyUpdate(dir);
    assert.equal(
      readFileSync(join(dir, ".env"), "utf8"),
      "private fixture, not a key",
    );
    assert.equal(
      readFileSync(join(dir, "assistant.md"), "utf8"),
      "custom instructions",
    );
    assert.equal(
      readFileSync(join(data, "stemme.sqlite"), "utf8"),
      "existing conversation fixture",
    );
    assert.match(
      readFileSync(join(dir, "src/orchestrator.ts"), "utf8"),
      /speechJob/,
    );
    assert.match(
      readFileSync(join(dir, "public/style.css"), "utf8"),
      /voice-vibration/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("Mac updater refuses an unrelated directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "stemme-update-invalid-"));
  try {
    assert.throws(() => copyUpdate(dir), /eksisterende/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
