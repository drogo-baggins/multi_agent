export interface SearchConfig {
  searxngUrl: string;
  timeoutMs: number;
  maxResults: number;
  userAgent: string;
}

/** Loads search config from environment variables. */
export function loadSearchConfig(): SearchConfig {
  return {
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8888",
    timeoutMs: Number(process.env.SEARXNG_TIMEOUT_MS) || 30000,
    maxResults: Number(process.env.SEARXNG_MAX_RESULTS) || 10,
    userAgent: "pi-agent/1.0"
  };
}
