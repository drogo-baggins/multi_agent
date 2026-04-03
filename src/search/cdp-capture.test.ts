import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl, scorePageForUrl } from "./cdp-capture.js";

describe("cdp-capture – normalizeUrl", () => {
  it("strips trailing slash for matching", () => {
    assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  });

  it("keeps path intact", () => {
    assert.equal(normalizeUrl("https://example.com/path"), "https://example.com/path");
  });
});

describe("cdp-capture – scorePageForUrl", () => {
  it("returns 3 for exact URL match", () => {
    assert.equal(scorePageForUrl("https://example.com/page", "https://example.com/page"), 3);
  });

  it("returns 3 for match after trailing-slash normalization", () => {
    assert.equal(scorePageForUrl("https://example.com/page/", "https://example.com/page"), 3);
  });

  it("returns 2 for prefix match", () => {
    assert.equal(scorePageForUrl("https://example.com/page/detail", "https://example.com/page"), 2);
  });

  it("returns 1 for non-chrome non-matching page", () => {
    assert.equal(scorePageForUrl("https://other.com/", "https://example.com/"), 1);
  });

  it("returns 0 for chrome:// pages", () => {
    assert.equal(scorePageForUrl("chrome://newtab/", "https://example.com/"), 0);
  });
});
