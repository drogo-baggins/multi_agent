import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { searchWeb } from "../search/index.js";

const WebSearchParametersSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number())
});

type WebSearchParameters = Static<typeof WebSearchParametersSchema>;

export function createWebSearchTool(): AgentTool<typeof WebSearchParametersSchema> {
  return {
    name: "web_search",
    label: "Web Search",
    description: "Searches the web for relevant information.",
    parameters: WebSearchParametersSchema,
    async execute(_toolCallId: string, params: WebSearchParameters, _signal?: AbortSignal) {
      try {
        const response = await searchWeb(params.query, { limit: params.maxResults });
        const results = response.results;

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results found for "${params.query}".` }],
            details: { query: params.query, resultCount: 0, results }
          };
        }

        const formattedMarkdown = results
          .map(
            (result, index) =>
              `${index + 1}. **${result.title}**\n   ${result.url}\n   ${result.snippet}`
          )
          .join("\n\n");

        return {
          content: [{ type: "text", text: formattedMarkdown }],
          details: { query: params.query, resultCount: results.length, results }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Search failed: ${message}` }],
          details: { query: params.query, error: message }
        };
      }
    }
  };
}
