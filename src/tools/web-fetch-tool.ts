import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { extractContent } from "../search/index.js";

const MAX_CONTENT_CHARS = 30000;

const WebFetchParametersSchema = Type.Object({
  url: Type.String()
});

type WebFetchParameters = Static<typeof WebFetchParametersSchema>;

export function createWebFetchTool(): AgentTool<typeof WebFetchParametersSchema> {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetches a web page and extracts its content as readable markdown.",
    parameters: WebFetchParametersSchema,
    async execute(_toolCallId: string, params: WebFetchParameters, _signal?: AbortSignal) {
      try {
        const extracted = await extractContent(params.url);

        if (extracted.error) {
          return {
            content: [{ type: "text", text: `Failed to fetch ${params.url}: ${extracted.error}` }],
            details: { url: params.url, error: extracted.error }
          };
        }

        const truncated = extracted.content.length > MAX_CONTENT_CHARS;
        const body = truncated
          ? `${extracted.content.slice(0, MAX_CONTENT_CHARS)}\n\n[Content truncated...]`
          : extracted.content;
        const title = extracted.title || "Untitled";
        const formattedContent = `# ${title}\nSource: ${params.url}\n\n${body}`;

        return {
          content: [{ type: "text", text: formattedContent }],
          details: {
            url: params.url,
            title,
            truncated,
            contentLength: extracted.content.length
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Failed to fetch ${params.url}: ${message}` }],
          details: { url: params.url, error: message }
        };
      }
    }
  };
}
