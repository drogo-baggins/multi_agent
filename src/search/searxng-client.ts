import { loadSearchConfig, type FallbackProvider, type SearchConfig } from "./search-config.js";
import { searchTavily, searchBrave, searchSerper } from "./fallback-client.js";

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

async function trySearxng(
  query: string,
  config: SearchConfig,
  limit: number
): Promise<SearchResult[]> {
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
    return (raw ?? [])
      .slice(0, limit)
      .filter((r): r is SearxngRawResult & { url: string } => typeof r.url === "string")
      .map(r => ({
        title: r.title || "Untitled",
        url: r.url,
        snippet: r.content || r.abstract || "",
        publishedDate: r.publishedDate || r.published_date,
        engine: r.engine
      }));
  } finally {
    clearTimeout(timeout);
  }
}

async function tryFallback(
  provider: FallbackProvider,
  query: string,
  config: SearchConfig,
  limit: number
): Promise<SearchResult[] | null> {
  const timeoutMs = config.timeoutMs;
  switch (provider) {
    case "tavily":
      if (!config.tavilyApiKey) return null;
      return searchTavily(query, { apiKey: config.tavilyApiKey, maxResults: limit, timeoutMs });
    case "brave":
      if (!config.braveApiKey) return null;
      return searchBrave(query, { apiKey: config.braveApiKey, maxResults: limit, timeoutMs });
    case "serper":
      if (!config.serperApiKey) return null;
      return searchSerper(query, { apiKey: config.serperApiKey, maxResults: limit, timeoutMs });
  }
}

export async function searchWeb(
  query: string,
  options?: { limit?: number; config?: SearchConfig }
): Promise<SearchResponse> {
  const config = options?.config ?? loadSearchConfig();
  const limit = options?.limit ?? config.maxResults;

  try {
    const results = await trySearxng(query, config, limit);
    return { results, query };
  } catch (searxngError) {
    for (const provider of config.fallbackProviders) {
      try {
        const results = await tryFallback(provider, query, config, limit);
        if (results !== null) return { results, query };
      } catch {
        // try next provider
      }
    }
    const message = searxngError instanceof Error ? searxngError.message : String(searxngError);
    throw new Error(`Failed to search SearXNG for "${query}": ${message}`);
  }
}
