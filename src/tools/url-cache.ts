/**
 * Session-scoped URL cache shared across all web_fetch calls within a process lifetime.
 * Prevents redundant network requests when the LLM revisits the same URL within a session.
 */
export interface CachedPage {
  formattedContent: string;
  title: string;
}

export const urlCache = new Map<string, CachedPage>();
