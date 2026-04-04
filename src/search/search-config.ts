export type FallbackProvider = "tavily" | "brave" | "serper";
export type SearchMode = "auto" | "human";

export interface SearchConfig {
  mode: SearchMode;
  searxngUrl: string;
  timeoutMs: number;
  maxResults: number;
  userAgent: string;
  chromeWindowPosition?: string;
  chromeWindowSize?: string;
  fallbackProviders: FallbackProvider[];
  tavilyApiKey?: string;
  braveApiKey?: string;
  serperApiKey?: string;
}

/** Loads search config from environment variables. */
export function loadSearchConfig(): SearchConfig {
  const mode: SearchMode = process.env.SEARCH_MODE === "human" ? "human" : "auto";
  const raw = process.env.SEARCH_FALLBACK_PROVIDERS ?? "";
  const fallbackProviders = raw
    .split(",")
    .map(s => s.trim())
    .filter((s): s is FallbackProvider => s === "tavily" || s === "brave" || s === "serper");

  return {
    mode,
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8888",
    timeoutMs: Number(process.env.SEARXNG_TIMEOUT_MS) || 30000,
    maxResults: Number(process.env.SEARXNG_MAX_RESULTS) || 10,
    userAgent: "pi-agent/1.0",
    chromeWindowPosition: process.env.CHROME_WINDOW_POSITION || undefined,
    chromeWindowSize: process.env.CHROME_WINDOW_SIZE || undefined,
    fallbackProviders,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    serperApiKey: process.env.SERPER_API_KEY
  };
}
