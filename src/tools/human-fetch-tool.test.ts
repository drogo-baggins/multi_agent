import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFetchResult } from "./human-fetch-tool.js";

describe("human-fetch-tool – formatFetchResult", () => {
  it("formats title, source URL and content", () => {
    const result = formatFetchResult("https://example.com", "Example", "Hello World");
    assert.ok(result.includes("# Example"));
    assert.ok(result.includes("https://example.com"));
    assert.ok(result.includes("Hello World"));
  });

  it("truncates content exceeding MAX_CONTENT_CHARS", () => {
    const longContent = "x".repeat(100000);
    const result = formatFetchResult("https://example.com", "Title", longContent);
    assert.ok(result.includes("[Content truncated"));
    assert.ok(result.length < longContent.length);
  });

  it("does not truncate content within limit", () => {
    const shortContent = "Short content";
    const result = formatFetchResult("https://example.com", "Title", shortContent);
    assert.ok(!result.includes("[Content truncated"));
    assert.ok(result.includes(shortContent));
  });
});
