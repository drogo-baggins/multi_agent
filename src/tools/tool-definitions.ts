import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ToolDefinition, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

import type { AgentRegistry } from "../communication/agent-registry.js";
import { invokeAgent } from "../communication/invoke-agent.js";
import { relayEvents } from "../communication/event-relay.js";
import { searchWeb } from "../search/index.js";
import { extractContent } from "../search/index.js";
import { createLoopCallbacks, type UserInteraction } from "../loop/loop-integration.js";
import { runPersistenceLoop } from "../loop/persistence-loop.js";

const RouteParametersSchema = Type.Object({
  message: Type.String()
});

const AskUserParametersSchema = Type.Object({
  question: Type.String()
});

const WebSearchParametersSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number())
});

const WebFetchParametersSchema = Type.Object({
  url: Type.String()
});

const StartResearchLoopParametersSchema = Type.Object({
  task: Type.String(),
  maxIterations: Type.Optional(Type.Number())
});

const MAX_CONTENT_CHARS = 30000;

function createRouteToolDefinition(
  name: string,
  label: string,
  description: string,
  target: string,
  registry: AgentRegistry
): ToolDefinition<typeof RouteParametersSchema> {
  return {
    name,
    label,
    description,
    parameters: RouteParametersSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof RouteParametersSchema>,
      _signal: AbortSignal | undefined,
      onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> {
      const childAgent = await registry.get(target);
      const unsubscribe = onUpdate ? relayEvents(childAgent, onUpdate) : null;
      try {
        return await invokeAgent(childAgent, params.message);
      } finally {
        unsubscribe?.();
      }
    }
  };
}

function createAskUserToolDefinition(): ToolDefinition<typeof AskUserParametersSchema> {
  return {
    name: "ask_user",
    label: "Ask User",
    description: "Asks the user for clarification and returns their response.",
    parameters: AskUserParametersSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof AskUserParametersSchema>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> {
      if (ctx.hasUI) {
        const answer = await ctx.ui.input(params.question);
        return {
          content: [{ type: "text", text: answer ?? "" }],
          details: undefined
        };
      }

      return {
        content: [{ type: "text", text: "[No interactive UI available]" }],
        details: undefined
      };
    }
  };
}

function createWebSearchToolDefinition(): ToolDefinition<typeof WebSearchParametersSchema> {
  return {
    name: "web_search",
    label: "Web Search",
    description: "Searches the web for relevant information.",
    parameters: WebSearchParametersSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof WebSearchParametersSchema>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> {
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

function createWebFetchToolDefinition(): ToolDefinition<typeof WebFetchParametersSchema> {
  return {
    name: "web_fetch",
    label: "Web Fetch",
    description: "Fetches a web page and extracts its content as readable markdown.",
    parameters: WebFetchParametersSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof WebFetchParametersSchema>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> {
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

function createStartResearchLoopToolDefinition(
  registry: AgentRegistry,
  workerConfigDir: string,
  logsDir?: string
): ToolDefinition<typeof StartResearchLoopParametersSchema> {
  return {
    name: "start_research_loop",
    label: "Start Research Loop",
    description: "Starts the persistence loop: Worker executes the task, Manager evaluates, user gives feedback, and the cycle repeats until the user approves or quits.",
    parameters: StartResearchLoopParametersSchema,
    async execute(
      _toolCallId: string,
      params: Static<typeof StartResearchLoopParametersSchema>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      ctx: ExtensionContext
    ): Promise<AgentToolResult<unknown>> {
      const ui: UserInteraction = ctx.hasUI
        ? {
            select: async (title, options) => ctx.ui.select(title, options),
            input: async (title, placeholder?) => ctx.ui.input(title, placeholder),
            notify: (message) => ctx.ui.notify(message)
          }
        : {
            select: async () => "approve",
            input: async () => undefined,
            notify: () => {}
          };

      const iterationReports: string[] = [];
      const callbacks = createLoopCallbacks({
        registry,
        workerConfigDir,
        ui,
        logsDir,
        task: params.task,
        onIterationReport: (report) => {
          iterationReports.push(report);
        }
      });

      try {
        const results = await runPersistenceLoop(params.task, callbacks, {
          maxIterations: params.maxIterations ?? 10
        });

        const lastResult = results[results.length - 1];
        const summary = [
          `Loop completed: ${results.length} iteration(s)`,
          `Final outcome: ${lastResult?.outcome ?? "unknown"}`,
          `Final score: ${lastResult?.evaluation.qualityScore ?? 0}/100`,
          "",
          "Iteration reports:",
          ...iterationReports
        ].join("\n");

        return {
          content: [{ type: "text", text: summary }],
          details: {
            iterationCount: results.length,
            finalOutcome: lastResult?.outcome,
            finalScore: lastResult?.evaluation.qualityScore
          }
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text", text: `Research loop failed: ${message}` }],
          details: { error: message }
        };
      }
    }
  };
}

export interface CustomToolsOptions {
  registry: AgentRegistry;
  workerConfigDir: string;
  logsDir?: string;
}

export function createCustomToolDefinitions(options: CustomToolsOptions): ToolDefinition<any>[] {
  return [
    createRouteToolDefinition(
      "route_to_worker",
      "Route to Worker",
      "Forwards a work request to the Worker Agent.",
      "worker",
      options.registry
    ),
    createRouteToolDefinition(
      "route_to_manager",
      "Route to Manager",
      "Forwards an improvement request to the Manager Agent.",
      "manager",
      options.registry
    ),
    createAskUserToolDefinition(),
    createWebSearchToolDefinition(),
    createWebFetchToolDefinition(),
    createStartResearchLoopToolDefinition(options.registry, options.workerConfigDir, options.logsDir)
  ];
}
