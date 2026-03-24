import { loadSearchConfig, type SearchConfig } from "./search-config.js";

interface SearxngRawResult {
  title?: string;
  url?: string;
  content?: string;
  abstract?: string;
  publishedDate?: string;
  published_date?: string;
  engine?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  engine?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  query: string;
}

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

export class Semaphore {
  private running = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly max: number) {}

  acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }
}

let _globalSemaphore: Semaphore | undefined;

function getGlobalSemaphore(): Semaphore {
  if (!_globalSemaphore) {
    _globalSemaphore = new Semaphore(loadSearchConfig().concurrencyLimit);
  }
  return _globalSemaphore;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  maxRetries: number
): Promise<Response> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const res = await fetch(url, init);
    if (!RETRYABLE_STATUSES.has(res.status)) return res;

    lastError = new Error(`SearXNG request failed with HTTP ${res.status}`);
    if (attempt === maxRetries) break;

    const retryAfterHeader = res.headers.get("Retry-After");
    const waitMs = retryAfterHeader
      ? parseInt(retryAfterHeader, 10) * 1000
      : Math.min(200 * 2 ** attempt + Math.random() * 100, 10000);
    await sleep(waitMs);
  }
  throw lastError!;
}

export async function searchWeb(
  query: string,
  options?: { limit?: number; config?: SearchConfig; semaphore?: Semaphore }
): Promise<SearchResponse> {
  const config = options?.config ?? loadSearchConfig();
  const semaphore = options?.semaphore ?? getGlobalSemaphore();
  const url = new URL(`${config.searxngUrl}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");

  await semaphore.acquire();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetchWithRetry(
        url.toString(),
        { signal: controller.signal, headers: { Accept: "application/json", "User-Agent": config.userAgent } },
        config.maxRetries
      );
      if (!res.ok) throw new Error(`SearXNG request failed with HTTP ${res.status}`);
      const json: unknown = await res.json();
      const raw = (json as { results?: SearxngRawResult[] }).results;
      const sliced = (raw ?? []).slice(0, options?.limit ?? config.maxResults);
      const results = sliced
        .filter((r): r is SearxngRawResult & { url: string } => typeof r.url === "string")
        .map((r) => ({
          title: r.title || "Untitled",
          url: r.url,
          snippet: r.content || r.abstract || "",
          publishedDate: r.publishedDate || r.published_date,
          engine: r.engine
        }));
      return { results, query };
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to search SearXNG for "${query}": ${message}`);
  } finally {
    semaphore.release();
  }
}
