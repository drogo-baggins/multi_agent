import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { capturePageWithCdp } from "../search/cdp-capture.js";
import { extractContentFromHtml } from "../search/content-extractor.js";

const MAX_CONTENT_CHARS = 30000;

export function formatFetchResult(url: string, title: string, content: string): string {
  const truncated = content.length > MAX_CONTENT_CHARS;
  const body = truncated
    ? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[Content truncated...]`
    : content;
  return `# ${title}\nSource: ${url}\n\n${body}`;
}

const HumanFetchParametersSchema = Type.Object({
  url: Type.String(),
});

type HumanFetchParameters = Static<typeof HumanFetchParametersSchema>;

export function createHumanFetchTool(): AgentTool<typeof HumanFetchParametersSchema> {
  return {
    name: "web_fetch",
    label: "Web Fetch (Human-assisted)",
    description:
      "Fetches a web page. Opens the URL in a browser for human interaction " +
      "(login, CAPTCHA, etc.), then captures the page DOM automatically.",
    parameters: HumanFetchParametersSchema,
    async execute(_toolCallId: string, params: HumanFetchParameters, _signal?: AbortSignal) {
      process.stdout.write(`\n`);
      process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.stdout.write(`[human mode] 取得URL: ${params.url}\n`);
      process.stdout.write(`[human mode] ブラウザでページを開きます...\n`);
      process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

      const result = await capturePageWithCdp(params.url, {
        waitUntil: "networkidle",
      });

      if (result.skipped || result.html === "") {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch ${params.url}: skipped by user or timed out.`,
            },
          ],
          details: { url: params.url, error: "skipped" },
        };
      }

      const extracted = extractContentFromHtml(result.url, result.html);

      if (extracted.error) {
        return {
          content: [{ type: "text", text: `Failed to fetch ${params.url}: ${extracted.error}` }],
          details: { url: params.url, error: extracted.error },
        };
      }

      const title = extracted.title || result.title || "Untitled";
      const formattedContent = formatFetchResult(result.url, title, extracted.content);

      return {
        content: [{ type: "text", text: formattedContent }],
        details: {
          url: result.url,
          title,
          truncated: extracted.content.length > MAX_CONTENT_CHARS,
          contentLength: extracted.content.length,
        },
      };
    },
  };
}
