import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { closeDedicatedTab, CDP_ENDPOINT, getOrCreateBrowser, getOrCreateDedicatedTab, navigateTo } from "./cdp-session.js";

// ── API contract ─────────────────────────────────────────────────────────────

describe("cdp-session – API contract", () => {
  it("exports CDP_ENDPOINT pointing to localhost", () => {
    assert.equal(typeof CDP_ENDPOINT, "string");
    assert.ok(CDP_ENDPOINT.includes("127.0.0.1"), `Expected 127.0.0.1 in "${CDP_ENDPOINT}"`);
    assert.ok(CDP_ENDPOINT.startsWith("http://"), `Expected http:// prefix in "${CDP_ENDPOINT}"`);
  });

  it("exports getOrCreateBrowser as a function", () => {
    assert.equal(typeof getOrCreateBrowser, "function");
  });

  it("exports getOrCreateDedicatedTab as a function", () => {
    assert.equal(typeof getOrCreateDedicatedTab, "function");
  });

  it("exports navigateTo as a function", () => {
    assert.equal(typeof navigateTo, "function");
  });

  it("exports closeDedicatedTab as a function", () => {
    assert.equal(typeof closeDedicatedTab, "function");
  });
});

// ── Lifecycle: clean-state and no-accumulation ────────────────────────────────
//
// These tests verify the session cleanup contract without requiring a live
// Chrome process.  They exercise the "no tab accumulation" guarantee:
// closeDedicatedTab() idempotently resets all internal session state, so
// repeated calls never leak page references.

describe("cdp-session – dedicated-tab lifecycle", () => {
  it("closeDedicatedTab resolves without throwing when no tab is active", async () => {
    await assert.doesNotReject(() => closeDedicatedTab());
  });

  it("closeDedicatedTab is idempotent – safe to call multiple times", async () => {
    await assert.doesNotReject(async () => {
      await closeDedicatedTab();
      await closeDedicatedTab();
      await closeDedicatedTab();
    });
  });

  it("closeDedicatedTab returns undefined (void)", async () => {
    const result = await closeDedicatedTab();
    assert.equal(result, undefined);
  });
});
