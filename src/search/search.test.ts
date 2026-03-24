import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import { extractContent, loadSearchConfig, searchWeb } from "./index.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function htmlResponse(html: string, status = 200, headers?: Record<string, string>): Response {
  return new Response(html, { status, headers });
}

describe("loadSearchConfig", () => {
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {
      SEARXNG_URL: process.env.SEARXNG_URL,
      SEARXNG_TIMEOUT_MS: process.env.SEARXNG_TIMEOUT_MS,
      SEARXNG_MAX_RESULTS: process.env.SEARXNG_MAX_RESULTS
    };

    delete process.env.SEARXNG_URL;
    delete process.env.SEARXNG_TIMEOUT_MS;
    delete process.env.SEARXNG_MAX_RESULTS;
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("returns defaults when no env vars are set", () => {
    const config = loadSearchConfig();

    assert.equal(config.searxngUrl, "http://localhost:8888");
    assert.equal(config.timeoutMs, 30000);
    assert.equal(config.maxResults, 10);
    assert.equal(config.userAgent, "pi-agent/1.0");
  });

  it("reads SEARXNG_URL from env", () => {
    process.env.SEARXNG_URL = "http://search.internal:8081";

    const config = loadSearchConfig();

    assert.equal(config.searxngUrl, "http://search.internal:8081");
  });

  it("reads SEARXNG_TIMEOUT_MS from env", () => {
    process.env.SEARXNG_TIMEOUT_MS = "12345";

    const config = loadSearchConfig();

    assert.equal(config.timeoutMs, 12345);
  });

  it("reads SEARXNG_MAX_RESULTS from env", () => {
    process.env.SEARXNG_MAX_RESULTS = "7";

    const config = loadSearchConfig();

    assert.equal(config.maxResults, 7);
  });

  it("handles invalid numbers gracefully by using defaults", () => {
    process.env.SEARXNG_TIMEOUT_MS = "not-a-number";
    process.env.SEARXNG_MAX_RESULTS = "still-not-a-number";

    const config = loadSearchConfig();

    assert.equal(config.timeoutMs, 30000);
    assert.equal(config.maxResults, 10);
  });
});

describe("searchWeb", () => {
  const config = {
    searxngUrl: "http://searxng.local",
    timeoutMs: 250,
    maxResults: 10,
    maxRetries: 0,
    concurrencyLimit: 2,
    userAgent: "pi-agent/test"
  };
  let semaphore: import("./searxng-client.js").Semaphore;

  beforeEach(async () => {
    const { Semaphore } = await import("./index.js");
    semaphore = new Semaphore(2);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("returns parsed results from SearXNG JSON response", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        results: [{ title: "Example", url: "https:example.com", content: "Snippet" }]
      })
    );

    const response = await searchWeb("example query", { config, semaphore });

    assert.equal(response.query, "example query");
    assert.equal(response.results.length, 1);
    assert.deepEqual(response.results[0], {
      title: "Example",
      url: "https:example.com",
      snippet: "Snippet",
      publishedDate: undefined,
      engine: undefined
    });
  });

  it("respects limit parameter", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        results: [
          { title: "One", url: "https:example.com/1", content: "first" },
          { title: "Two", url: "https:example.com/2", content: "second" }
        ]
      })
    );

    const response = await searchWeb("limited", { config, limit: 1, semaphore });

    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.title, "One");
  });

  it("throws descriptive error on non-200 response", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({ error: "bad" }, 503));

    await assert.rejects(
      () => searchWeb("service outage", { config, semaphore }),
      /Failed to search SearXNG for "service outage": SearXNG request failed with HTTP 503/
    );
  });

  it("throws on network failure", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("network unreachable");
    });

    await assert.rejects(
      () => searchWeb("broken network", { config, semaphore }),
      /Failed to search SearXNG for "broken network": network unreachable/
    );
  });

  it("handles empty results array", async () => {
    mock.method(globalThis, "fetch", async () => jsonResponse({ results: [] }));

    const response = await searchWeb("nothing", { config, semaphore });

    assert.deepEqual(response, { query: "nothing", results: [] });
  });

  it("maps SearXNG fields correctly including abstract fallback", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        results: [
          {
            title: "Content Source",
            url: "https:example.com/content",
            content: "content snippet",
            abstract: "unused abstract",
            publishedDate: "2026-01-01",
            engine: "duckduckgo"
          },
          {
            title: "Abstract Source",
            url: "https:example.com/abstract",
            abstract: "abstract snippet",
            published_date: "2026-01-02",
            engine: "google"
          }
        ]
      })
    );

    const response = await searchWeb("field mapping", { config, semaphore });

    assert.deepEqual(response.results[0], {
      title: "Content Source",
      url: "https:example.com/content",
      snippet: "content snippet",
      publishedDate: "2026-01-01",
      engine: "duckduckgo"
    });
    assert.deepEqual(response.results[1], {
      title: "Abstract Source",
      url: "https:example.com/abstract",
      snippet: "abstract snippet",
      publishedDate: "2026-01-02",
      engine: "google"
    });
  });

  it("filters out results without url", async () => {
    mock.method(globalThis, "fetch", async () =>
      jsonResponse({
        results: [
          { title: "Missing URL", content: "discard me" },
          { title: "Valid URL", url: "https:example.com/valid", content: "keep me" }
        ]
      })
    );

    const response = await searchWeb("url filter", { config, semaphore });

    assert.equal(response.results.length, 1);
    assert.equal(response.results[0]?.title, "Valid URL");
    assert.equal(response.results[0]?.url, "https:example.com/valid");
  });
});

describe("Semaphore", () => {
  it("limits concurrent executions to the specified maximum", async () => {
    const { Semaphore } = await import("./index.js");
    const sem = new Semaphore(2);
    let concurrent = 0;
    let maxConcurrent = 0;

    const task = async () => {
      await sem.acquire();
      try {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise(r => setImmediate(r));
      } finally {
        concurrent--;
        sem.release();
      }
    };

    await Promise.all([task(), task(), task(), task()]);

    assert.equal(maxConcurrent, 2);
  });

  it("releases the slot after an error so subsequent tasks can proceed", async () => {
    const { Semaphore } = await import("./index.js");
    const sem = new Semaphore(1);

    const failingTask = async () => {
      await sem.acquire();
      sem.release();
      throw new Error("intentional");
    };

    await assert.rejects(failingTask);

    let reached = false;
    await sem.acquire();
    reached = true;
    sem.release();

    assert.ok(reached);
  });
});

describe("searchWeb retry behaviour", () => {
  const config = {
    searxngUrl: "http://searxng.local",
    timeoutMs: 5000,
    maxResults: 10,
    maxRetries: 1,
    concurrencyLimit: 2,
    userAgent: "pi-agent/test"
  };

  afterEach(() => {
    mock.restoreAll();
  });

  it("retries on 429 and succeeds on the next attempt", async () => {
    const { Semaphore } = await import("./index.js");
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
          headers: { "content-type": "application/json" }
        });
      }
      return jsonResponse({ results: [{ title: "OK", url: "https://example.com", content: "good" }] });
    });

    const response = await searchWeb("retry test", { config, semaphore: new Semaphore(2) });

    assert.equal(calls, 2);
    assert.equal(response.results.length, 1);
  });

  it("retries on 503 and succeeds on the next attempt", async () => {
    const { Semaphore } = await import("./index.js");
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({}), { status: 503 });
      }
      return jsonResponse({ results: [{ title: "OK", url: "https://example.com", content: "ok" }] });
    });

    const response = await searchWeb("503 retry", { config, semaphore: new Semaphore(2) });

    assert.equal(calls, 2);
    assert.equal(response.results.length, 1);
  });

  it("respects Retry-After header and waits the specified duration", async () => {
    const { Semaphore } = await import("./index.js");
    let calls = 0;
    const start = Date.now();
    mock.method(globalThis, "fetch", async () => {
      calls++;
      if (calls === 1) {
        return new Response(JSON.stringify({}), {
          status: 429,
          headers: { "Retry-After": "1" }
        });
      }
      return jsonResponse({ results: [] });
    });

    await searchWeb("retry-after", { config, semaphore: new Semaphore(2) });

    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 900, `Expected >= 900ms wait, got ${elapsed}ms`);
    assert.equal(calls, 2);
  });

  it("throws after exhausting all retries", async () => {
    const { Semaphore } = await import("./index.js");
    mock.method(globalThis, "fetch", async () =>
      new Response(JSON.stringify({}), { status: 429 })
    );

    await assert.rejects(
      () => searchWeb("always fails", { config, semaphore: new Semaphore(2) }),
      /Failed to search SearXNG for "always fails": SearXNG request failed with HTTP 429/
    );
  });

  it("does not retry on 404 (non-retryable status)", async () => {
    const { Semaphore } = await import("./index.js");
    let calls = 0;
    mock.method(globalThis, "fetch", async () => {
      calls++;
      return new Response(JSON.stringify({}), { status: 404 });
    });

    await assert.rejects(
      () => searchWeb("not found", { config, semaphore: new Semaphore(2) }),
      /HTTP 404/
    );
    assert.equal(calls, 1);
  });
});

describe("extractContent", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("extracts content and converts to markdown", async () => {
    mock.method(globalThis, "fetch", async () =>
      htmlResponse(
        "<html><head><title>Readable</title></head><body><article><p>Hello <strong>world</strong>.</p></article></body></html>"
      )
    );

    const result = await extractContent("https:example.com/article");

    assert.equal(result.url, "https:example.com/article");
    assert.equal(result.title, "Readable");
    assert.match(result.content, /Hello \*\*world\*\*\./);
    assert.equal(result.error, undefined);
  });

  it("returns error for non-200 responses", async () => {
    mock.method(globalThis, "fetch", async () => htmlResponse("not found", 404));

    const result = await extractContent("https:example.com/missing");

    assert.equal(result.error, "HTTP 404");
    assert.equal(result.content, "");
  });

  it("returns error for content too large via Content-Length header", async () => {
    mock.method(globalThis, "fetch", async () => htmlResponse("small", 200, { "content-length": "100" }));

    const result = await extractContent("https:example.com/huge", { maxSize: 10 });

    assert.equal(result.error, "Content too large: 100 bytes");
    assert.equal(result.content, "");
  });

  it("returns error when Readability cannot parse", async () => {
    mock.method(globalThis, "fetch", async () => htmlResponse("<html><body></body></html>"));

    const result = await extractContent("https:example.com/unreadable");

    assert.equal(result.error, "Could not extract content");
    assert.equal(result.content, "");
  });

  it("never throws and returns error in result", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw "non-error failure";
    });

    await assert.doesNotReject(async () => {
      const result = await extractContent("https:example.com/no-throw");
      assert.equal(result.error, "non-error failure");
      assert.equal(result.content, "");
    });
  });

  it("handles fetch failures gracefully", async () => {
    mock.method(globalThis, "fetch", async () => {
      throw new Error("request timed out");
    });

    const result = await extractContent("https:example.com/failure");

    assert.equal(result.error, "request timed out");
    assert.equal(result.content, "");
  });
});
