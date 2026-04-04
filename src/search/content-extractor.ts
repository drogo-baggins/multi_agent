import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_SIZE = 5 * 1024 * 1024;
const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });

export interface ExtractedContent {
  url: string;
  title: string;
  content: string;
  byline?: string;
  error?: string;
}

/** Fetches a URL and extracts readable markdown content without throwing. */
export async function extractContent(
  url: string,
  options?: { timeoutMs?: number; maxSize?: number }
): Promise<ExtractedContent> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
      }
    });
    if (!response.ok) return { url, title: "", content: "", error: `HTTP ${response.status}` };
    const length = response.headers.get("content-length");
    if (length && Number(length) > maxSize) {
      return { url, title: "", content: "", error: `Content too large: ${length} bytes` };
    }
    const html = await response.text();
    if (html.length > maxSize) {
      return { url, title: "", content: "", error: `Content too large: ${html.length} bytes` };
    }
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (!article?.content) return { url, title: "", content: "", error: "Could not extract content" };
    return {
      url,
      title: article.title || "",
      content: turndown.turndown(article.content),
      byline: article.byline || undefined
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, title: "", content: "", error: message };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * HTML 文字列から readable markdown を抽出する。
 * CDP / Playwright など HTTP GET を経由しない取得手段と組み合わせて使う。
 * 戻り値の型は extractContent() と同一。
 */
export function extractContentFromHtml(url: string, html: string): ExtractedContent {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (!article?.content) {
      return { url, title: "", content: "", error: "Could not extract content" };
    }
    return {
      url,
      title: article.title || "",
      content: turndown.turndown(article.content),
      byline: article.byline || undefined
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, title: "", content: "", error: message };
  }
}
