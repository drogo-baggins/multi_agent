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
import { createAuditLogger } from "../loop/manager-audit-log.js";
import { runDecomposedLoop } from "../loop/task-orchestrator.js";

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
  maxIterations: Type.Optional(Type.Number()),
  qualityThreshold: Type.Optional(Type.Number())
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
    description: "Starts the persistence loop: Worker executes the task, Manager evaluates, and the cycle repeats. When qualityThreshold is set (0-100), the loop runs autonomously — auto-approving when the score meets the threshold, and auto-improving otherwise. Without qualityThreshold, the user is prompted each iteration.",
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

      const auditLogger = logsDir
        ? await createAuditLogger(logsDir, params.task)
        : undefined;

      const iterationReports: string[] = [];
      const callbacks = createLoopCallbacks({
        registry,
        workerConfigDir,
        ui,
        logsDir,
        task: params.task,
        qualityThreshold: params.qualityThreshold,
        auditLogger,
        onIterationReport: (report) => {
          iterationReports.push(report);
        }
      });

      try {
        const managerAgent = await registry.get("manager");
        const result = await runDecomposedLoop({
          task: params.task,
          managerAgent,
          callbacks,
          auditLogger,
          notify: ui.notify,
          maxIterationsPerUnit: params.maxIterations ?? 10,
          iterationTimeoutMs: 600_000
        });

        const summary = [
          `Research completed: ${result.workUnitResults.length} work unit(s)`,
          result.wasSingleUnit
            ? "(single unit — no decomposition)"
            : `(decomposed into ${result.workUnitResults.length} units)`,
          `Total duration: ${(result.totalDurationMs / 1000).toFixed(1)}s`,
          "",
          "Iteration reports:",
          ...iterationReports
        ].join("\n");

        return {
          content: [{ type: "text", text: result.synthesizedWorkProduct || summary }],
          details: {
            workUnitCount: result.workUnitResults.length,
            wasSingleUnit: result.wasSingleUnit,
            totalDurationMs: result.totalDurationMs
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
