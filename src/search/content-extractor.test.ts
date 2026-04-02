import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractContentFromHtml } from "./content-extractor.js";

describe("extractContentFromHtml", () => {
  it("extracts title and content from HTML string", () => {
    const html = `
      <html><head><title>Test Page</title></head>
      <body><article><p>Hello World</p></article></body></html>
    `;
    const result = extractContentFromHtml("https://example.com", html);
    assert.equal(result.url, "https://example.com");
    assert.ok(result.title.length > 0 || result.content.includes("Hello"));
    assert.equal(result.error, undefined);
  });

  it("returns error when HTML has no extractable content", () => {
    const result = extractContentFromHtml("https://example.com", "<html></html>");
    assert.ok(result.error !== undefined);
  });
});
