import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { searchTavily, searchBrave, searchSerper } from "./fallback-client.js";
import type { SearchResult } from "./searxng-client.js";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers }
  });
}

describe("searchTavily", () => {
  afterEach(() => mock.restoreAll());

  it("returns normalized results from Tavily response", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        results: [
          { title: "Tavily Result", url: "https://example.com", content: "A snippet", published_date: "2026-01-15" }
        ]
      })
    );

    const results = await searchTavily("test query", { apiKey: "tvly-test", maxResults: 5 });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      title: "Tavily Result",
      url: "https://example.com",
      snippet: "A snippet",
      publishedDate: "2026-01-15",
      engine: "tavily"
    } satisfies SearchResult);
  });

  it("sends correct POST request to Tavily", async () => {
    let capturedRequest: { url: string; init: RequestInit } | undefined;
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      capturedRequest = { url, init };
      return jsonResponse({ results: [] });
    });

    await searchTavily("my query", { apiKey: "tvly-abc123", maxResults: 7 });

    assert.equal(capturedRequest?.url, "https://api.tavily.com/search");
    assert.equal(capturedRequest?.init.method, "POST");
    const headers = capturedRequest?.init.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer tvly-abc123");
    assert.equal(headers["Content-Type"], "application/json");
    const body = JSON.parse(capturedRequest?.init.body as string);
    assert.equal(body.query, "my query");
    assert.equal(body.max_results, 7);
  });

  it("filters results missing url", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        results: [
          { title: "No URL", content: "discard" },
          { title: "Has URL", url: "https://example.com/good", content: "keep" }
        ]
      })
    );

    const results = await searchTavily("query", { apiKey: "key" });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Has URL");
  });

  it("throws on non-200 response", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({ error: "unauthorized" }, 401));

    await assert.rejects(
      () => searchTavily("query", { apiKey: "bad-key" }),
      /Tavily.*401/
    );
  });

  it("returns empty array when results field is missing", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({}));

    const results = await searchTavily("query", { apiKey: "key" });

    assert.deepEqual(results, []);
  });
});

describe("searchBrave", () => {
  afterEach(() => mock.restoreAll());

  it("returns normalized results from Brave response", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        web: {
          results: [
            { title: "Brave Result", url: "https://brave.example.com", description: "Brave snippet", page_age: "2026-02-01" }
          ]
        }
      })
    );

    const results = await searchBrave("test query", { apiKey: "brave-test", maxResults: 5 });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      title: "Brave Result",
      url: "https://brave.example.com",
      snippet: "Brave snippet",
      publishedDate: "2026-02-01",
      engine: "brave"
    } satisfies SearchResult);
  });

  it("sends correct GET request to Brave", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      return jsonResponse({ web: { results: [] } });
    });

    await searchBrave("brave search", { apiKey: "brave-xyz", maxResults: 3 });

    const parsed = new URL(capturedUrl);
    assert.equal(parsed.origin + parsed.pathname, "https://api.search.brave.com/res/v1/web/search");
    assert.equal(parsed.searchParams.get("q"), "brave search");
    assert.equal(parsed.searchParams.get("count"), "3");
    assert.equal(capturedHeaders["X-Subscription-Token"], "brave-xyz");
    assert.equal(capturedHeaders["Accept"], "application/json");
  });

  it("filters results missing url", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        web: {
          results: [
            { title: "No URL", description: "discard" },
            { title: "Has URL", url: "https://example.com/good", description: "keep" }
          ]
        }
      })
    );

    const results = await searchBrave("query", { apiKey: "key" });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Has URL");
  });

  it("throws on non-200 response", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({ error: "forbidden" }, 403));

    await assert.rejects(
      () => searchBrave("query", { apiKey: "bad-key" }),
      /Brave.*403/
    );
  });

  it("returns empty array when web.results is missing", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({ web: {} }));

    const results = await searchBrave("query", { apiKey: "key" });

    assert.deepEqual(results, []);
  });
});

describe("searchSerper", () => {
  afterEach(() => mock.restoreAll());

  it("returns normalized results from Serper response", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        organic: [
          { title: "Serper Result", link: "https://serper.example.com", snippet: "Serper snippet", date: "Mar 1, 2026" }
        ]
      })
    );

    const results = await searchSerper("test query", { apiKey: "serper-test", maxResults: 5 });

    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      title: "Serper Result",
      url: "https://serper.example.com",
      snippet: "Serper snippet",
      publishedDate: "Mar 1, 2026",
      engine: "serper"
    } satisfies SearchResult);
  });

  it("sends correct POST request to Serper", async () => {
    let capturedRequest: { url: string; init: RequestInit } | undefined;
    mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
      capturedRequest = { url, init };
      return jsonResponse({ organic: [] });
    });

    await searchSerper("serper query", { apiKey: "serper-key", maxResults: 4 });

    assert.equal(capturedRequest?.url, "https://google.serper.dev/search");
    assert.equal(capturedRequest?.init.method, "POST");
    const headers = capturedRequest?.init.headers as Record<string, string>;
    assert.equal(headers["X-API-KEY"], "serper-key");
    assert.equal(headers["Content-Type"], "application/json");
    const body = JSON.parse(capturedRequest?.init.body as string);
    assert.equal(body.q, "serper query");
    assert.equal(body.num, 4);
  });

  it("filters results missing link", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        organic: [
          { title: "No Link", snippet: "discard" },
          { title: "Has Link", link: "https://example.com/good", snippet: "keep" }
        ]
      })
    );

    const results = await searchSerper("query", { apiKey: "key" });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, "Has Link");
  });

  it("throws on non-200 response", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({ message: "invalid api key" }, 403));

    await assert.rejects(
      () => searchSerper("query", { apiKey: "bad-key" }),
      /Serper.*403/
    );
  });

  it("returns empty array when organic field is missing", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({}));

    const results = await searchSerper("query", { apiKey: "key" });

    assert.deepEqual(results, []);
  });
});
