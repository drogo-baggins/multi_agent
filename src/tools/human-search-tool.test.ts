import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl } from "./human-search-tool.js";

describe("human-search-tool – buildSearchUrl", () => {
  it("uses Google when SEARXNG_URL is not set", () => {
    const original = process.env.SEARXNG_URL;
    delete process.env.SEARXNG_URL;
    const url = buildSearchUrl("TypeScript async");
    assert.ok(url.includes("google.com/search"));
    assert.ok(url.includes("TypeScript"));
    if (original !== undefined) process.env.SEARXNG_URL = original;
  });

  it("uses SearXNG when SEARXNG_URL is set", () => {
    const original = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = "http://localhost:8888";
    const url = buildSearchUrl("TypeScript async");
    assert.ok(url.includes("localhost:8888"));
    if (original !== undefined) process.env.SEARXNG_URL = original;
    else delete process.env.SEARXNG_URL;
  });

  it("URL-encodes the query", () => {
    const url = buildSearchUrl("hello world");
    assert.ok(url.includes("hello%20world") || url.includes("hello+world"));
  });
});
