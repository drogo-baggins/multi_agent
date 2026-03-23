import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { IterationResult } from "./persistence-loop.js";
import type { EvaluationIssue } from "./evaluation-report.js";

function formatTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatIssue(issue: EvaluationIssue, index: number): string {
  return [
    `${index + 1}. **[${issue.category}]** ${issue.description}`,
    `   - Evidence: ${issue.evidence}`,
    `   - Cause: ${issue.cause}`
  ].join("\n");
}

export function formatAuditEntry(result: IterationResult, timestamp: Date): string {
  const header = `## Iteration ${result.iteration}`;
  const time = `**Time**: ${timestamp.toISOString()}`;
  const outcome = `**Outcome**: ${result.outcome}`;
  const score = `**Quality Score**: ${result.evaluation.qualityScore}/100`;

  const summary = `### Manager Evaluation\n\n${result.evaluation.summary}`;

  const issuesSection =
    result.evaluation.issues.length > 0
      ? `### Issues Detected (${result.evaluation.issues.length})\n\n${result.evaluation.issues.map((issue, i) => formatIssue(issue, i)).join("\n\n")}`
      : "### Issues Detected\n\nNone";

  const improvementsSection =
    result.improvements.length > 0
      ? `### Improvement Instructions (${result.improvements.length})\n\n${result.improvements.map((inst, i) => `${i + 1}. ${inst}`).join("\n")}`
      : "### Improvement Instructions\n\nNone (no improvement cycle)";

  const latency = [
    "### Latency",
    "",
    `| Phase | Duration |`,
    `|-------|----------|`,
    `| Worker Execution | ${formatDuration(result.latencyMs.workerExecutionMs)} |`,
    `| Manager Evaluation | ${formatDuration(result.latencyMs.evaluationMs)} |`,
    `| Manager Improvement | ${formatDuration(result.latencyMs.managerImprovementMs)} |`,
    `| **Total** | **${formatDuration(result.latencyMs.totalMs)}** |`
  ].join("\n");

  return [header, "", time, outcome, score, "", summary, "", issuesSection, "", improvementsSection, "", latency, "", "---", ""].join("\n");
}

function buildFileHeader(task: string, startTime: Date): string {
  return [
    "# Manager Audit Log",
    "",
    `**Task**: ${task}`,
    `**Started**: ${startTime.toISOString()}`,
    "",
    "---",
    "",
    ""
  ].join("\n");
}

export interface AuditLogger {
  logIteration(result: IterationResult): Promise<void>;
}

export async function createAuditLogger(logsDir: string, task: string): Promise<AuditLogger> {
  await mkdir(logsDir, { recursive: true });

  const startTime = new Date();
  const filename = `manager-audit-${formatTimestamp(startTime)}.md`;
  const filePath = join(logsDir, filename);

  let headerWritten = false;

  return {
    async logIteration(result: IterationResult): Promise<void> {
      if (!headerWritten) {
        await appendFile(filePath, buildFileHeader(task, startTime), "utf-8");
        headerWritten = true;
      }
      const entry = formatAuditEntry(result, new Date());
      await appendFile(filePath, entry, "utf-8");
    }
  };
}
