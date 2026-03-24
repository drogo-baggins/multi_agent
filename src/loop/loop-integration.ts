import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { AgentRegistry } from "../communication/agent-registry.js";
import { invokeAgent } from "../communication/invoke-agent.js";
import { loadAgentConfig } from "../config/config-loader.js";
import { formatEvaluationReport, parseEvaluationReport } from "./evaluation-report.js";
import { formatImprovementRequest, type ImprovementRequest } from "./improvement-request.js";
import { createAuditLogger, type AuditLogger } from "./manager-audit-log.js";
import type { IterationResult, LoopCallbacks, UserFeedback, WorkerContext } from "./persistence-loop.js";

export interface UserInteraction {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string): void;
}

export interface LoopStatusReporter {
  onWorkerStart(iteration: number, maxIterations: number): void;
  onEvaluationStart(iteration: number, maxIterations: number): void;
  onFeedbackWaiting(iteration: number, maxIterations: number, score: number): void;
  onImprovementStart(iteration: number, maxIterations: number): void;
  onLoopComplete(totalIterations: number, finalScore: number): void;
  onLoopInterrupted(iteration: number): void;
}

export interface LoopIntegrationOptions {
  registry: AgentRegistry;
  workerConfigDir: string;
  ui: UserInteraction;
  logsDir?: string;
  task?: string;
  qualityThreshold?: number;
  maxIterations?: number;
  statusReporter?: LoopStatusReporter;
  onIterationReport?: (report: string) => void;
  auditLogger?: AuditLogger;
}

interface LoopIntegrationDependencies {
  invokeAgent: typeof invokeAgent;
  loadAgentConfig: typeof loadAgentConfig;
}

export const loopIntegrationDependencies: LoopIntegrationDependencies = {
  invokeAgent,
  loadAgentConfig
};

const evaluationPromptHeader = [
  "Evaluate the following work product. Respond ONLY with a structured evaluation report in this exact format:",
  "",
  "## Quality Score",
  "[0-100 number]",
  "",
  "## Summary",
  "[1-3 sentence summary]",
  "",
  "## Issues",
  "[For each issue:]",
  "Category: [coverage|accuracy|structure|citations|other]",
  "Description: [what the issue is]",
  "Evidence: [specific evidence from the work product]",
  "Cause: [config|task-difficulty|llm-limitation]",
  "",
  "---",
  "Work Product:"
].join("\n");

function extractTextOrThrow(result: AgentToolResult<void>): string {
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if ("isError" in result && result.isError === true) {
    throw new Error(text || "Agent invocation failed");
  }

  return text;
}

function formatIterationReport(result: IterationResult): string {
  return [
    `Iteration ${result.iteration}`,
    `Outcome: ${result.outcome}`,
    `Quality Score: ${result.evaluation.qualityScore}/100`,
    `Latency: ${result.latencyMs.totalMs}ms`
  ].join(" | ");
}

function parseImprovementResponse(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  return lines.length > 0 ? lines : [text.trim()].filter((line) => line.length > 0);
}

export function createLoopCallbacks(options: LoopIntegrationOptions): LoopCallbacks {
  const { ui } = options;
  let currentIteration = 1;

  let auditLogger: AuditLogger | null = null;
  let auditLoggerInitPromise: Promise<AuditLogger> | null = null;

  async function getAuditLogger(): Promise<AuditLogger | null> {
    if (options.auditLogger) {
      return options.auditLogger;
    }
    if (!options.logsDir) {
      return null;
    }
    if (auditLogger) {
      return auditLogger;
    }
    if (!auditLoggerInitPromise) {
      auditLoggerInitPromise = createAuditLogger(options.logsDir, options.task ?? "unknown");
    }
    auditLogger = await auditLoggerInitPromise;
    return auditLogger;
  }

  return {
    executeWorker: async (task: string, context: WorkerContext): Promise<string> => {
      options.statusReporter?.onWorkerStart(context.iteration, options.maxIterations ?? 10);
      const workerAgent = await options.registry.get("worker");
      workerAgent.reset();

      let prompt = task;
      if (context.iteration > 1) {
        const parts = [
          `これはイテレーション${context.iteration}です。output/ ディレクトリに前回の作業結果があります。`,
          "まず output/progress.md を読み取り、前回の進捗を確認してから作業を継続してください。"
        ];

        if (context.previousEvaluation) {
          parts.push(`\n前回の評価スコア: ${context.previousEvaluation.qualityScore}/100`);
          parts.push(`前回の評価要約: ${context.previousEvaluation.summary}`);
          if (context.previousEvaluation.issues.length > 0) {
            const issueList = context.previousEvaluation.issues
              .map((issue) => `- [${issue.category}] ${issue.description}`)
              .join("\n");
            parts.push(`\n改善すべき課題:\n${issueList}`);
          }
        }

        if (context.previousFeedback) {
          parts.push(`\nユーザーからのフィードバック: ${context.previousFeedback}`);
        }

        prompt = `${task}\n\n---\n${parts.join("\n")}`;
      }

      const response = await loopIntegrationDependencies.invokeAgent(workerAgent, prompt);
      return extractTextOrThrow(response);
    },

    evaluateProduct: async (workProduct: string) => {
      options.statusReporter?.onEvaluationStart(currentIteration, options.maxIterations ?? 10);
      const managerAgent = await options.registry.get("manager");
      const prompt = `${evaluationPromptHeader}\n${workProduct}`;
      const response = await loopIntegrationDependencies.invokeAgent(managerAgent, prompt);
      return parseEvaluationReport(extractTextOrThrow(response));
    },

    getUserFeedback: async (_workProduct: string, evaluation, iteration): Promise<UserFeedback> => {
      const report = formatEvaluationReport(evaluation);
      const summary = `=== Iteration ${iteration} ===\nScore: ${evaluation.qualityScore}/100\nSummary: ${evaluation.summary}\nIssues: ${evaluation.issues.length}\n\n${report}`;

      ui.notify(summary);

      if (options.qualityThreshold !== undefined) {
        if (evaluation.qualityScore >= options.qualityThreshold) {
          return { type: "approved" };
        }
        const issueDescriptions = evaluation.issues
          .map((issue) => `[${issue.category}] ${issue.description}`)
          .join("; ");
        return {
          type: "improve",
          feedback: issueDescriptions || `Quality score ${evaluation.qualityScore} is below threshold ${options.qualityThreshold}. Improve overall quality.`
        };
      }

      options.statusReporter?.onFeedbackWaiting(iteration, options.maxIterations ?? 10, evaluation.qualityScore);

      const decision = await ui.select(
        "How would you like to proceed?",
        ["approve", "improve", "quit"]
      );

      if (decision === "approve") {
        return { type: "approved" };
      }

      if (decision === "improve") {
        const feedback = await ui.input("Feedback for improvement:");
        return { type: "improve", feedback: feedback?.trim() ?? "" };
      }

      return { type: "interrupt" };
    },

    executeImprovement: async (requests: ImprovementRequest[]): Promise<string[]> => {
      options.statusReporter?.onImprovementStart(currentIteration, options.maxIterations ?? 10);
      const managerAgent = await options.registry.get("manager");
      const requestBody = requests.map((request, index) => `### Request ${index + 1}\n${formatImprovementRequest(request)}`).join("\n\n");
      const prompt = [
        "Apply the following improvement requests by updating the worker configuration.",
        "Use update_worker_config as needed, then summarize the changes made.",
        "",
        requestBody
      ].join("\n");

      const response = await loopIntegrationDependencies.invokeAgent(managerAgent, prompt);
      const text = extractTextOrThrow(response);
      options.registry.evict("worker");
      const responses = parseImprovementResponse(text);

      void getAuditLogger().then((logger) => logger?.logImprovementExecution(requests, responses));

      return responses;
    },

    readCurrentConfig: async (): Promise<string> => loopIntegrationDependencies.loadAgentConfig(options.workerConfigDir),

    onIterationComplete: (result: IterationResult): void => {
      options.onIterationReport?.(formatIterationReport(result));

      if (result.outcome === "user-approved" || result.outcome === "max-iterations" || result.outcome === "timeout") {
        options.statusReporter?.onLoopComplete(result.iteration, result.evaluation.qualityScore);
      } else if (result.outcome === "user-interrupted") {
        options.statusReporter?.onLoopInterrupted(result.iteration);
      } else if (result.outcome === "improvement-applied") {
        currentIteration = result.iteration + 1;
      }

      void getAuditLogger().then((logger) => logger?.logIteration(result));
    }
  };
}
