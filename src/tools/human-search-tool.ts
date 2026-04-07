import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

import { capturePageWithCdp } from "../search/cdp-capture.js";
import { loadSearchConfig, assertSafeOutboundUrl } from "../search/index.js";
import { extractContentFromHtml } from "../search/content-extractor.js";
import type { HumanToolCdpCallbacks } from "./human-tool-status-ref.js";

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

export function createHumanSearchTool(
  cdpCallbacks?: HumanToolCdpCallbacks
): AgentTool<typeof HumanSearchParametersSchema> {
  return {
    name: "web_search",
    label: "Web Search (Human-assisted)",
    description:
      "Opens dedicated overlay and target windows, auto-navigates the target window to the search URL, " +
      "and asks the human to confirm the page and click the capture button in the overlay.",
    parameters: HumanSearchParametersSchema,
    async execute(
      _toolCallId: string,
      params: HumanSearchParameters,
      signal?: AbortSignal,
      onUpdate?: Parameters<AgentTool<typeof HumanSearchParametersSchema>["execute"]>[3]
    ) {
      const searchUrl = buildSearchUrl(params.query);
      const config = loadSearchConfig();
      try {
        assertSafeOutboundUrl(searchUrl, { allowedOrigins: config.urlAllowlist ?? [] });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Search failed for "${params.query}": ${message}` }],
          details: { query: params.query, error: message }
        };
      }

      onUpdate?.({
        content: [{ type: "text", text: `[human mode] ブラウザの調査対象ウィンドウを確認し、オーバーレイのボタンを押してください: ${searchUrl}` }],
        details: undefined
      });

      cdpCallbacks?.onPromptReady(`[human mode] ブラウザの調査対象ウィンドウを確認し、オーバーレイのボタンを押してください: ${searchUrl}`);

      try {
        const result = await capturePageWithCdp(searchUrl, {
          waitUntil: "domcontentloaded",
          signal,
          onPromptReady: (prompt) => cdpCallbacks?.onPromptReady(prompt)
        });

        if (result.skipped || result.html === "") {
          const isInjectFailure = result.reason === "inject-failure";
          onUpdate?.({
            content: [{
              type: "text",
              text: isInjectFailure
                ? `[human mode] 検索完了: ${params.query} (取得不可)`
                : `[human mode] 検索完了: ${params.query} (skipped)`
            }],
            details: undefined
          });
          if (isInjectFailure) {
            return {
              content: [{ type: "text", text: `Search unavailable for "${params.query}": browser capture UI could not be injected.` }],
              details: { query: params.query, resultCount: 0, results: [], skipped: true, reason: "inject-failure" }
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `No results provided for "${params.query}". Skipped by user or timed out.`
              }
            ],
            details: { query: params.query, resultCount: 0, results: [], skipped: true, reason: result.reason }
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

        onUpdate?.({
          content: [{ type: "text", text: `[human mode] 検索完了: ${params.query}` }],
          details: undefined
        });

        return {
          content: [{ type: "text", text: formattedMarkdown }],
          details: {
            query: params.query,
            resultCount: 1,
            results: [{ url: result.url, content: extracted.content }]
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onUpdate?.({
          content: [{ type: "text", text: `[human mode] 検索失敗: ${params.query}` }],
          details: undefined
        });
        return {
          content: [{ type: "text", text: `Search failed for "${params.query}": ${message}` }],
          details: { query: params.query, error: message }
        };
      }
    }
  };
}
