import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFetchResult } from "./human-fetch-tool.js";

describe("human-fetch-tool – formatFetchResult", () => {
  it("formats output identical to web_fetch", () => {
    const result = formatFetchResult("https://example.com", "Test Title", "Hello World");
    assert.ok(result.startsWith("# Test Title\n"));
    assert.ok(result.includes("Source: https://example.com"));
    assert.ok(result.includes("Hello World"));
  });

  it("truncates content over MAX_CONTENT_CHARS", () => {
    const long = "x".repeat(35000);
    const result = formatFetchResult("https://example.com", "T", long);
    assert.ok(result.includes("[Content truncated...]"));
  });
});
