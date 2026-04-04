import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl } from "./human-search-tool.js";

describe("human-search-tool – buildSearchUrl", () => {
  it("uses Google by default (never SearXNG)", () => {
    const original = process.env.HUMAN_SEARCH_ENGINE;
    delete process.env.HUMAN_SEARCH_ENGINE;
    const url = buildSearchUrl("TypeScript async");
    assert.ok(url.includes("google.com/search"), `expected google.com in ${url}`);
    assert.ok(!url.includes("searxng") && !url.includes("localhost"), `should not use SearXNG in ${url}`);
    if (original !== undefined) process.env.HUMAN_SEARCH_ENGINE = original;
  });

  it("uses HUMAN_SEARCH_ENGINE override when set", () => {
    const original = process.env.HUMAN_SEARCH_ENGINE;
    process.env.HUMAN_SEARCH_ENGINE = "https://duckduckgo.com/?q=";
    const url = buildSearchUrl("TypeScript async");
    assert.ok(url.includes("duckduckgo.com"), `expected duckduckgo in ${url}`);
    if (original !== undefined) process.env.HUMAN_SEARCH_ENGINE = original;
    else delete process.env.HUMAN_SEARCH_ENGINE;
  });

  it("URL-encodes the query", () => {
    const url = buildSearchUrl("hello world");
    assert.ok(url.includes("hello%20world") || url.includes("hello+world"));
  });
});
