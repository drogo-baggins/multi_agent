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

/** Runs a SearXNG web search and returns normalized results. */
export async function searchWeb(
  query: string,
  options?: { limit?: number; config?: SearchConfig }
): Promise<SearchResponse> {
  const config = options?.config ?? loadSearchConfig();
  const url = new URL(`${config.searxngUrl}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("safesearch", "0");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": config.userAgent }
    });
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to search SearXNG for "${query}": ${message}`);
  } finally {
    clearTimeout(timeout);
  }
}
