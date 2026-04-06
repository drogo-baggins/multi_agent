import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

import { capturePageWithCdp } from "../search/cdp-capture.js";
import { extractContentFromHtml } from "../search/content-extractor.js";
import type { HumanToolCdpCallbacks } from "./human-tool-status-ref.js";

const MAX_CONTENT_CHARS = 80000;

export function formatFetchResult(url: string, title: string, content: string): string {
  const truncated = content.length > MAX_CONTENT_CHARS;
  const body = truncated
    ? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[Content truncated at ${MAX_CONTENT_CHARS} characters. Fetching this URL again will return the same result — the remaining content cannot be retrieved.]`
    : content;
  return `# ${title}\nSource: ${url}\n\n${body}`;
}

const HumanFetchParametersSchema = Type.Object({
  url: Type.String()
});

type HumanFetchParameters = Static<typeof HumanFetchParametersSchema>;

export function createHumanFetchTool(
  cdpCallbacks?: HumanToolCdpCallbacks
): AgentTool<typeof HumanFetchParametersSchema> {
  return {
    name: "web_fetch",
    label: "Web Fetch (Human-assisted)",
    description:
      "Fetches a web page. Opens the URL in a browser for human interaction " +
      "(login, CAPTCHA, etc.), then captures the page DOM automatically.",
    parameters: HumanFetchParametersSchema,
    async execute(
      _toolCallId: string,
      params: HumanFetchParameters,
      signal?: AbortSignal,
      onUpdate?: Parameters<AgentTool<typeof HumanFetchParametersSchema>["execute"]>[3]
    ) {
      onUpdate?.({
        content: [{ type: "text", text: `[human mode] 取得URL: ${params.url}` }],
        details: undefined
      });

      cdpCallbacks?.onPromptReady(`[human mode] ブラウザで取得中: ${params.url}`);

      try {
        const result = await capturePageWithCdp(params.url, {
          waitUntil: "networkidle",
          signal,
          onPromptReady: (prompt) => cdpCallbacks?.onPromptReady(prompt)
        });

        if (result.skipped || result.html === "") {
          const isInjectFailure = result.reason === "inject-failure";
          onUpdate?.({
            content: [{
              type: "text",
              text: isInjectFailure
                ? `[human mode] 取得完了: ${params.url} (取得不可)`
                : `[human mode] 取得完了: ${params.url} (skipped)`
            }],
            details: undefined
          });
          if (isInjectFailure) {
            return {
              content: [{ type: "text", text: `Failed to fetch ${params.url}: 取得不可 (browser capture UI could not be injected).` }],
              details: { url: params.url, error: "取得不可", reason: "inject-failure" }
            };
          }
          return {
            content: [
              {
                type: "text",
                text: `Failed to fetch ${params.url}: skipped by user or timed out.`
              }
            ],
            details: { url: params.url, error: "skipped", reason: result.reason }
          };
        }

        const extracted = extractContentFromHtml(result.url, result.html);

        if (extracted.error) {
          onUpdate?.({
            content: [{ type: "text", text: `[human mode] 取得失敗: ${params.url}` }],
            details: undefined
          });
          return {
            content: [{ type: "text", text: `Failed to fetch ${params.url}: ${extracted.error}` }],
            details: { url: params.url, error: extracted.error }
          };
        }

        const title = extracted.title || result.title || "Untitled";
        const formattedContent = formatFetchResult(result.url, title, extracted.content);

        onUpdate?.({
          content: [{ type: "text", text: `[human mode] 取得完了: ${params.url}` }],
          details: undefined
        });

        return {
          content: [{ type: "text", text: formattedContent }],
          details: {
            url: result.url,
            title,
            truncated: extracted.content.length > MAX_CONTENT_CHARS,
            contentLength: extracted.content.length
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onUpdate?.({
          content: [{ type: "text", text: `[human mode] 取得失敗: ${params.url}` }],
          details: undefined
        });
        return {
          content: [{ type: "text", text: `Failed to fetch ${params.url}: ${message}` }],
          details: { url: params.url, error: message }
        };
      }
    }
  };
}
