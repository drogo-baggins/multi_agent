import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

import { capturePageWithCdp } from "../search/cdp-capture.js";
import { extractContentFromHtml } from "../search/content-extractor.js";

const MAX_CONTENT_CHARS = 80000;

const DEFAULT_SEARCH_ENGINE = "https://www.google.com/search?q=";

export function buildSearchUrl(query: string): string {
  const encoded = encodeURIComponent(query);
  const engine = process.env.HUMAN_SEARCH_ENGINE ?? DEFAULT_SEARCH_ENGINE;
  return `${engine.replace(/[?&]$/, "")}${engine.includes("?") ? "&" : "?"}q=${encoded}`;
}

const HumanSearchParametersSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number())
});

type HumanSearchParameters = Static<typeof HumanSearchParametersSchema>;

export function createHumanSearchTool(): AgentTool<typeof HumanSearchParametersSchema> {
  return {
    name: "web_search",
    label: "Web Search (Human-assisted)",
    description:
      "Searches the web. Opens a browser with the query pre-filled; " +
      "the human presses the search button, then the result page is captured automatically.",
    parameters: HumanSearchParametersSchema,
    async execute(_toolCallId: string, params: HumanSearchParameters, _signal?: AbortSignal) {
      const searchUrl = buildSearchUrl(params.query);

      process.stdout.write(`\n`);
      process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.stdout.write(`[human mode] 検索クエリ: ${params.query}\n`);
      process.stdout.write(`[human mode] ブラウザで検索ページを開きます...\n`);
      process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      const result = await capturePageWithCdp(searchUrl, {
        waitUntil: "domcontentloaded"
      });

      if (result.skipped || result.html === "") {
        return {
          content: [
            {
              type: "text",
              text: `No results provided for "${params.query}". Skipped by user or timed out.`
            }
          ],
          details: { query: params.query, resultCount: 0, results: [], skipped: true }
        };
      }

      const extracted = extractContentFromHtml(result.url, result.html);
      const truncated = extracted.content.length > MAX_CONTENT_CHARS;
      const body = truncated
        ? `${extracted.content.slice(0, MAX_CONTENT_CHARS)}\n\n[Content truncated at ${MAX_CONTENT_CHARS} characters. Fetching this URL again will return the same result — the remaining content cannot be retrieved.]`
        : extracted.content;

      const formattedMarkdown = [
        `**Search query**: ${params.query}`,
        `**Source**: ${result.url}`,
        "",
        body
      ].join("\n");

      return {
        content: [{ type: "text", text: formattedMarkdown }],
        details: {
          query: params.query,
          resultCount: 1,
          results: [{ url: result.url, content: extracted.content }]
        }
      };
    }
  };
}
