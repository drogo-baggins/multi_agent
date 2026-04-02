import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "./cdp-capture.js";

describe("cdp-capture – normalizeUrl", () => {
  it("strips trailing slash for matching", () => {
    assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  });

  it("keeps path intact", () => {
    assert.equal(normalizeUrl("https://example.com/path"), "https://example.com/path");
  });
});
