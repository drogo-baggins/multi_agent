export interface SearchConfig {
  searxngUrl: string;
  timeoutMs: number;
  maxResults: number;
  userAgent: string;
  maxRetries: number;
  concurrencyLimit: number;
}

/** Loads search config from environment variables. */
export function loadSearchConfig(): SearchConfig {
  const timeoutMs = Number(process.env.SEARXNG_TIMEOUT_MS);
  const maxResults = Number(process.env.SEARXNG_MAX_RESULTS);
  const maxRetries = Number(process.env.SEARXNG_MAX_RETRIES);
  const concurrencyLimit = Number(process.env.SEARXNG_CONCURRENCY_LIMIT);
  return {
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8888",
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000,
    maxResults: Number.isFinite(maxResults) && maxResults > 0 ? maxResults : 10,
    userAgent: "pi-agent/1.0",
    maxRetries: Number.isFinite(maxRetries) && maxRetries >= 0 ? maxRetries : 3,
    concurrencyLimit: Number.isFinite(concurrencyLimit) && concurrencyLimit > 0 ? concurrencyLimit : 2
  };
}
