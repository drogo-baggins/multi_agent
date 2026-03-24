import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { AgentRegistry } from "../communication/agent-registry.js";
import { invokeAgent } from "../communication/invoke-agent.js";
import { loadAgentConfig } from "../config/config-loader.js";
import { formatEvaluationReport, parseEvaluationReport } from "./evaluation-report.js";
import { formatImprovementRequest, type ImprovementRequest } from "./improvement-request.js";
import type { IterationResult, LoopCallbacks, UserFeedback, WorkerContext } from "./persistence-loop.js";

export interface UserInteraction {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  notify(message: string): void;
}

export interface LoopIntegrationOptions {
  registry: AgentRegistry;
  workerConfigDir: string;
  workerSandboxDir?: string;
  ui: UserInteraction;
  onIterationReport?: (report: string) => void;
}

interface LoopIntegrationDependencies {
  invokeAgent: typeof invokeAgent;
  loadAgentConfig: typeof loadAgentConfig;
  readReportFile: (sandboxDir: string) => Promise<string>;
}

async function readReportFile(sandboxDir: string): Promise<string> {
  try {
    const content = await readFile(join(sandboxDir, "output", "report.md"), "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

export const loopIntegrationDependencies: LoopIntegrationDependencies = {
  invokeAgent,
  loadAgentConfig,
  readReportFile
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

  return {
    executeWorker: async (task: string, context: WorkerContext): Promise<string> => {
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
      const agentText = extractTextOrThrow(response);
      if (agentText) return agentText;
      if (options.workerSandboxDir) {
        return loopIntegrationDependencies.readReportFile(options.workerSandboxDir);
      }
      return "";
    },

    evaluateProduct: async (workProduct: string) => {
      const managerAgent = await options.registry.get("manager");
      const prompt = `${evaluationPromptHeader}\n${workProduct}`;
      const response = await loopIntegrationDependencies.invokeAgent(managerAgent, prompt);
      return parseEvaluationReport(extractTextOrThrow(response));
    },

    getUserFeedback: async (_workProduct: string, evaluation, iteration): Promise<UserFeedback> => {
      const report = formatEvaluationReport(evaluation);
      const summary = `=== Iteration ${iteration} ===\nScore: ${evaluation.qualityScore}/100\nSummary: ${evaluation.summary}\nIssues: ${evaluation.issues.length}\n\n${report}`;

      ui.notify(summary);

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
      return parseImprovementResponse(text);
    },

    readCurrentConfig: async (): Promise<string> => loopIntegrationDependencies.loadAgentConfig(options.workerConfigDir),

    onIterationComplete: (result: IterationResult): void => {
      options.onIterationReport?.(formatIterationReport(result));
    }
  };
}
