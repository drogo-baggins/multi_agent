import type { AgentToolResult, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";
import type { ToolDefinition, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

import type { AgentRegistry } from "../communication/agent-registry.js";
import { searchWeb } from "../search/index.js";
import { extractContent } from "../search/index.js";
import {
  createLoopCallbacks,
  type UserInteraction,
  type LoopStatusReporter
} from "../loop/loop-integration.js";
import type { InterruptRequest } from "../loop/persistence-loop.js";
import { createAuditLogger } from "../loop/manager-audit-log.js";
import { runDecomposedLoop } from "../loop/task-orchestrator.js";

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

      const STATUS_KEY = "loop";
      const maxIterations = params.maxIterations ?? 10;
      let channelVersion = 0;
      let resolveInterrupt: ((req: InterruptRequest) => void) | undefined;
      let isDialogOpen = false;

      function resetInterruptChannel(): Promise<InterruptRequest> {
        channelVersion += 1;
        const capturedVersion = channelVersion;
        return new Promise<InterruptRequest>((resolve) => {
          resolveInterrupt = (req) => {
            if (channelVersion === capturedVersion) {
              resolve(req);
            }
          };
        });
      }

      async function showInterruptDialog(): Promise<void> {
        if (!ctx.hasUI) {
          return;
        }

        const capturedResolve = resolveInterrupt;
        const capturedVersion = channelVersion;

        const choice = await ctx.ui.select(
          "Interrupt Worker",
          ["Stop and exit loop", "Modify task instructions", "Resume (cancel)"]
        );

        if (channelVersion !== capturedVersion) {
          return;
        }

        if (choice === "Stop and exit loop") {
          capturedResolve?.({ type: "stop" });
          if (resolveInterrupt === capturedResolve) {
            resolveInterrupt = undefined;
          }
          return;
        }

        if (choice === "Modify task instructions") {
          const feedback = await ctx.ui.input("New instructions for the Worker:");
          if (channelVersion !== capturedVersion) {
            return;
          }
          if (feedback && feedback.trim()) {
            capturedResolve?.({ type: "modify", feedback: feedback.trim() });
            if (resolveInterrupt === capturedResolve) {
              resolveInterrupt = undefined;
            }
          }
        }
      }

      const unsubscribeInput = ctx.hasUI
        ? ctx.ui.onTerminalInput((data: string) => {
            if (data === "\x18") {
              if (resolveInterrupt && !isDialogOpen) {
                isDialogOpen = true;
                void showInterruptDialog()
                  .catch(() => undefined)
                  .finally(() => {
                    isDialogOpen = false;
                  });
              }
              return { consume: true };
            }
            return undefined;
          })
        : () => {};

      const statusReporter: LoopStatusReporter | undefined = ctx.hasUI
        ? {
            onWorkerStart(iteration, max) {
              ctx.ui.setStatus(STATUS_KEY, `Iter ${iteration}/${max} — Worker running...  [Ctrl+X] Interrupt`);
              ctx.ui.setWorkingMessage(`Research loop Iter ${iteration}/${max}: Worker running`);
            },
            onEvaluationStart(iteration, max) {
              ctx.ui.setStatus(STATUS_KEY, `Iter ${iteration}/${max} — Manager evaluating...`);
              ctx.ui.setWorkingMessage(`Research loop Iter ${iteration}/${max}: Manager evaluating`);
            },
            onFeedbackWaiting(iteration, max, score) {
              ctx.ui.setStatus(
                STATUS_KEY,
                `Iter ${iteration}/${max} — Score: ${score}/100 — Awaiting feedback`
              );
              ctx.ui.setWorkingMessage();
            },
            onImprovementStart(iteration, max) {
              ctx.ui.setStatus(STATUS_KEY, `Iter ${iteration}/${max} — Manager improving...`);
              ctx.ui.setWorkingMessage(`Research loop Iter ${iteration}/${max}: Manager improving`);
            },
            onLoopComplete(totalIterations, finalScore) {
              ctx.ui.setStatus(
                STATUS_KEY,
                `Complete — ${totalIterations} iter, final score: ${finalScore}/100`
              );
              ctx.ui.setWorkingMessage();
            },
            onLoopInterrupted(iteration) {
              ctx.ui.setStatus(STATUS_KEY, `Interrupted — at iter ${iteration}`);
              ctx.ui.setWorkingMessage();
            }
          }
        : undefined;

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
        maxIterations,
        statusReporter,
        ...(ctx.hasUI
          ? {
              waitForInterrupt: () => resetInterruptChannel()
            }
          : {}),
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
          maxIterationsPerUnit: maxIterations,
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
       } finally {
          unsubscribeInput();
          if (ctx.hasUI) {
            ctx.ui.setStatus(STATUS_KEY, undefined);
            ctx.ui.setWorkingMessage();
          }
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
    createAskUserToolDefinition(),
    createWebSearchToolDefinition(),
    createWebFetchToolDefinition(),
    createStartResearchLoopToolDefinition(options.registry, options.workerConfigDir, options.logsDir)
  ];
}
