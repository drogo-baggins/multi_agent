import type { SearchResult } from "./searxng-client.js";

interface TavilyRawResult {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string;
}

interface BraveRawResult {
  title?: string;
  url?: string;
  description?: string;
  page_age?: string;
}

interface SerperRawResult {
  title?: string;
  link?: string;
  snippet?: string;
  date?: string;
}

export async function searchTavily(
  query: string,
  options: { apiKey: string; maxResults?: number; timeoutMs?: number }
): Promise<SearchResult[]> {
  const { apiKey, maxResults = 10, timeoutMs = 30000 } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ query, max_results: maxResults })
    });
    if (!res.ok) throw new Error(`Tavily request failed with HTTP ${res.status}`);
    const json = (await res.json()) as { results?: TavilyRawResult[] };
    return (json.results ?? [])
      .filter((r): r is TavilyRawResult & { url: string } => typeof r.url === "string")
      .map(r => ({
        title: r.title || "Untitled",
        url: r.url,
        snippet: r.content || "",
        publishedDate: r.published_date,
        engine: "tavily"
      }));
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchBrave(
  query: string,
  options: { apiKey: string; maxResults?: number; timeoutMs?: number }
): Promise<SearchResult[]> {
  const { apiKey, maxResults = 10, timeoutMs = 30000 } = options;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      signal: controller.signal,
      headers: {
        "X-Subscription-Token": apiKey,
        "Accept": "application/json"
      }
    });
    if (!res.ok) throw new Error(`Brave request failed with HTTP ${res.status}`);
    const json = (await res.json()) as { web?: { results?: BraveRawResult[] } };
    return (json.web?.results ?? [])
      .filter((r): r is BraveRawResult & { url: string } => typeof r.url === "string")
      .map(r => ({
        title: r.title || "Untitled",
        url: r.url,
        snippet: r.description || "",
        publishedDate: r.page_age,
        engine: "brave"
      }));
  } finally {
    clearTimeout(timeout);
  }
}

export async function searchSerper(
  query: string,
  options: { apiKey: string; maxResults?: number; timeoutMs?: number }
): Promise<SearchResult[]> {
  const { apiKey, maxResults = 10, timeoutMs = 30000 } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ q: query, num: maxResults })
    });
    if (!res.ok) throw new Error(`Serper request failed with HTTP ${res.status}`);
    const json = (await res.json()) as { organic?: SerperRawResult[] };
    return (json.organic ?? [])
      .filter((r): r is SerperRawResult & { link: string } => typeof r.link === "string")
      .map(r => ({
        title: r.title || "Untitled",
        url: r.link,
        snippet: r.snippet || "",
        publishedDate: r.date,
        engine: "serper"
      }));
  } finally {
    clearTimeout(timeout);
  }
}
