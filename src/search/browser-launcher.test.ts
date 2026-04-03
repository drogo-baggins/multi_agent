import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChromeArgs, getUserDataDir, waitForCdpReady } from "./browser-launcher.js";

describe("browser-launcher", () => {
  it("includes remote-debugging-port in chrome args", () => {
    const args = buildChromeArgs();
    assert.ok(args.some(a => a.startsWith("--remote-debugging-port=")));
  });

  it("includes user-data-dir in chrome args", () => {
    const args = buildChromeArgs();
    assert.ok(args.some(a => a.startsWith("--user-data-dir=")));
  });

  it("getUserDataDir returns a non-empty string", () => {
    const dir = getUserDataDir();
    assert.ok(dir.length > 0);
  });

  it("waitForCdpReady rejects when port is not open", async () => {
    await assert.rejects(
      () => waitForCdpReady(19999, 500),
      (err: Error) => err.message.includes("CDP not ready")
    );
  });
});
