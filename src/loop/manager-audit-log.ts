import { mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";

import type { IterationResult } from "./persistence-loop.js";
import type { EvaluationIssue } from "./evaluation-report.js";
import type { DecompositionPlan, WorkUnit, WorkUnitResult } from "./work-unit.js";

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
  logDecomposition(plan: DecompositionPlan): Promise<void>;
  logWorkUnitStart(unit: WorkUnit, index: number, total: number): Promise<void>;
  logWorkUnitComplete(result: WorkUnitResult, qualityScore: number): Promise<void>;
  logResplit(parent: WorkUnit, children: WorkUnit[], reason: string): Promise<void>;
  logSynthesis(unitCount: number, finalScore: number, durationMs: number): Promise<void>;
}

export async function createAuditLogger(logsDir: string, task: string): Promise<AuditLogger> {
  await mkdir(logsDir, { recursive: true });

  const startTime = new Date();
  const filename = `manager-audit-${formatTimestamp(startTime)}.md`;
  const filePath = join(logsDir, filename);

  let headerWritten = false;

  async function ensureHeader(): Promise<void> {
    if (!headerWritten) {
      await appendFile(filePath, buildFileHeader(task, startTime), "utf-8");
      headerWritten = true;
    }
  }

  return {
    async logIteration(result: IterationResult): Promise<void> {
      await ensureHeader();
      const entry = formatAuditEntry(result, new Date());
      await appendFile(filePath, entry, "utf-8");
    },

    async logDecomposition(plan: DecompositionPlan): Promise<void> {
      await ensureHeader();
      const timestamp = new Date().toISOString();
      const rows = plan.workUnits.map((unit, i) => `| ${i + 1} | ${unit.goal} | ${unit.scope} |`).join("\n");
      const entry = [
        "## Task Decomposition",
        "",
        `**Time**: ${timestamp}`,
        `**Original Task**: ${plan.originalTask}`,
        `**WorkUnits**: ${plan.workUnits.length} WorkUnits generated`,
        "",
        "| # | Goal | Scope |",
        "|---|------|-------|",
        rows,
        "",
        "---",
        ""
      ].join("\n");
      await appendFile(filePath, entry, "utf-8");
    },

    async logWorkUnitStart(unit: WorkUnit, index: number, total: number): Promise<void> {
      await ensureHeader();
      const entry = [
        `## WorkUnit [${index}/${total}] Started`,
        "",
        `**Time**: ${new Date().toISOString()}`,
        `**Goal**: ${unit.goal}`,
        `**Scope**: ${unit.scope}`,
        `**Depth**: ${unit.depth}`,
        "",
        "---",
        ""
      ].join("\n");
      await appendFile(filePath, entry, "utf-8");
    },

    async logWorkUnitComplete(result: WorkUnitResult, qualityScore: number): Promise<void> {
      await ensureHeader();
      const entry = [
        `## WorkUnit Completed: ${result.workUnit.goal}`,
        "",
        `**Time**: ${new Date().toISOString()}`,
        `**Duration**: ${formatDuration(result.durationMs)}`,
        `**Quality Score**: ${qualityScore}/100`,
        `**Findings length**: ${result.findings.length} chars`,
        "",
        "---",
        ""
      ].join("\n");
      await appendFile(filePath, entry, "utf-8");
    },

    async logResplit(parent: WorkUnit, children: WorkUnit[], reason: string): Promise<void> {
      await ensureHeader();
      const rows = children.map((unit, i) => `| ${i + 1} | ${unit.goal} | ${unit.scope} |`).join("\n");
      const entry = [
        `## WorkUnit Resplit: ${parent.goal}`,
        "",
        `**Time**: ${new Date().toISOString()}`,
        `**Reason**: ${reason}`,
        `**Parent Depth**: ${parent.depth}`,
        `**Children**: ${children.length} new WorkUnits`,
        "",
        "| # | Goal | Scope |",
        "|---|------|-------|",
        rows,
        "",
        "---",
        ""
      ].join("\n");
      await appendFile(filePath, entry, "utf-8");
    },

    async logSynthesis(unitCount: number, finalScore: number, durationMs: number): Promise<void> {
      await ensureHeader();
      const entry = [
        "## Synthesis Complete",
        "",
        `**Time**: ${new Date().toISOString()}`,
        `**WorkUnits synthesized**: ${unitCount}`,
        `**Final Quality Score**: ${finalScore}/100`,
        `**Synthesis Duration**: ${formatDuration(durationMs)}`,
        "",
        "---",
        ""
      ].join("\n");
      await appendFile(filePath, entry, "utf-8");
    }
  };
}
