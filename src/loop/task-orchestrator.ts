import type { Agent } from "@mariozechner/pi-agent-core";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { decomposeTask, resplitWorkUnit } from "./task-decomposer.js";
import { synthesizeResults } from "./result-synthesizer.js";
import type { LoopStatusReporter } from "./loop-integration.js";
import {
  MAX_DECOMPOSITION_DEPTH,
  MAX_RETRIES_PER_UNIT,
  createDecompositionPlan,
  createWorkUnit,
  type WorkUnit,
  type WorkUnitResult
} from "./work-unit.js";
import type { AuditLogger } from "./manager-audit-log.js";
import type { InterruptWaiter, LoopCallbacks, IterationResult, InterruptRequest } from "./persistence-loop.js";
import { runPersistenceLoop, withTimeoutAndInterrupt } from "./persistence-loop.js";

// ---------------------------------------------------------------------------
// WorkUnit state persistence
// ---------------------------------------------------------------------------

const RESUME_MARKER = "（前回の作業が中断されています";

/** Strip accumulated resume-suffix(es) from a task string to get the canonical form. */
function normalizeTask(task: string): string {
  const idx = task.indexOf(RESUME_MARKER);
  return (idx >= 0 ? task.slice(0, idx) : task).trim();
}

interface WorkUnitStateEntry {
  id: string;
  goal: string;
  scope: string;
  outOfScope: string;
  depth: number;
  parentId: string | null;
  retryCount: number;
  status: "pending" | "complete" | "failed" | "timeout";
  findings: string;
  remainingWork: string[];
  durationMs: number;
}

interface LoopStateFile {
  taskNormalized: string;
  createdAt: string;
  units: WorkUnitStateEntry[];
}

type TaskPlanStatus = "TODO" | "DOING" | "DONE";

interface TaskPlanL3Entry {
  id: string;
  description: string;
  status: TaskPlanStatus;
}

interface TaskPlanEntry {
  id: string;
  goal: string;
  scope: string;
  status: TaskPlanStatus;
  qualityScore?: number;
  findingsFile?: string;
  startedAt?: string;
  completedAt?: string;
  l3Entries?: TaskPlanL3Entry[];
}

async function readLoopState(stateFilePath: string): Promise<LoopStateFile | null> {
  try {
    const raw = await readFile(stateFilePath, "utf-8");
    return JSON.parse(raw) as LoopStateFile;
  } catch {
    return null;
  }
}

async function writeLoopState(stateFilePath: string, state: LoopStateFile): Promise<void> {
  try {
    await mkdir(join(stateFilePath, ".."), { recursive: true });
    await writeFile(stateFilePath, JSON.stringify(state, null, 2), "utf-8");
  } catch {
    // Non-fatal: state file write failure should not break the loop
  }
}

async function deleteLoopState(stateFilePath: string): Promise<void> {
  try {
    await unlink(stateFilePath);
  } catch {
    // Ignore if already gone
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatTaskPlanEntryLine(indent: string, status: TaskPlanStatus, id: string, goal: string): string {
  return `${indent}- ${status} [${id}] ${goal}`;
}

function buildTaskPlanContent(task: string, units: WorkUnit[], createdAt: string): string {
  const groups = new Map<string, WorkUnit[]>();
  const roots: WorkUnit[] = [];

  for (const unit of units) {
    if (unit.parentId) {
      const list = groups.get(unit.parentId) ?? [];
      list.push(unit);
      groups.set(unit.parentId, list);
    } else {
      roots.push(unit);
    }
  }

  const lines = [
    "# タスク計画",
    "",
    `**タスク**: ${task}`,
    `**作成日時**: ${createdAt}`,
    "**ステータス**: running",
    "",
    "## 成果物構造"
  ];

  const counters = new Map<number, number>();
  const nextId = (level: number): string => {
    const current = (counters.get(level) ?? 0) + 1;
    counters.set(level, current);
    return `L${level}-${String(current).padStart(3, "0")}`;
  };

  const emitUnit = (unit: WorkUnit, level: number): void => {
    const indent = "  ".repeat(Math.max(0, level - 1));
    lines.push(formatTaskPlanEntryLine(indent, "TODO", nextId(level), unit.goal));
    lines.push(`${indent}  - スコープ: ${unit.scope}`);
    if (unit.outOfScope) {
      lines.push(`${indent}  - 対象外: ${unit.outOfScope}`);
    }

    for (const child of groups.get(unit.id) ?? []) {
      emitUnit(child, level + 1);
    }
  };

  for (const root of roots) {
    emitUnit(root, 1);
  }

  lines.push("", "## ユーザー指示履歴", "- なし");
  return lines.join("\n");
}

async function readTaskPlan(planFilePath: string): Promise<{ entries: TaskPlanEntry[]; userDirectives: string[] } | null> {
  try {
    const raw = await readFile(planFilePath, "utf-8");
    const entries: TaskPlanEntry[] = [];
    const userDirectives: string[] = [];
    let inDirectiveSection = false;
    const stack: Array<{ indent: number; entry: TaskPlanEntry }> = [];

    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("## ユーザー指示履歴")) {
        inDirectiveSection = true;
        continue;
      }

      if (inDirectiveSection) {
        if (line.startsWith("## ")) {
          inDirectiveSection = false;
          continue;
        }
        const trimmed = line.trim();
        if (trimmed.startsWith("- ")) {
          userDirectives.push(trimmed.slice(2).trim());
        } else if (trimmed.length > 0) {
          userDirectives.push(trimmed);
        }
      }

      const entryMatch = line.match(/^(\s*)-\s*(TODO|DOING|DONE)\s+\[(L\d-\d+)\]\s+(.+)$/);
      if (entryMatch) {
        const indent = entryMatch[1]?.length ?? 0;
        const entry: TaskPlanEntry = {
          id: entryMatch[3]!,
          goal: entryMatch[4]!,
          scope: "",
          status: entryMatch[2] as TaskPlanStatus,
          l3Entries: []
        };

        while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) {
          stack.pop();
        }

        if (stack.length === 0) {
          entries.push(entry);
        } else {
          stack[stack.length - 1]!.entry.l3Entries ??= [];
          stack[stack.length - 1]!.entry.l3Entries!.push({ id: entry.id, description: entry.goal, status: entry.status });
        }

        stack.push({ indent, entry });
        continue;
      }

      const scopeMatch = line.match(/^(\s*)-\s*スコープ:\s*(.+)$/);
      if (scopeMatch) {
        const indent = scopeMatch[1]?.length ?? 0;
        for (let index = stack.length - 1; index >= 0; index -= 1) {
          const candidate = stack[index];
          if (candidate && candidate.indent < indent) {
            candidate.entry.scope = scopeMatch[2] ?? "";
            break;
          }
        }
      }
    }

    return { entries, userDirectives };
  } catch {
    return null;
  }
}

async function readTaskPlanRootTask(planFilePath: string): Promise<string | null> {
  try {
    const raw = await readFile(planFilePath, "utf-8");
    const match = raw.match(/^\*\*タスク\*\*:\s*(.+)$/m);
    return match?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function appendTaskPlanDirective(planFilePath: string, directive: string): Promise<void> {
  let content: string;
  try {
    content = await readFile(planFilePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split(/\r?\n/);
  const sectionIndex = lines.findIndex((line) => line.trim() === "## ユーザー指示履歴");
  const entryLine = `- [${new Date().toISOString()}] ${directive.trim()}`;

  if (sectionIndex < 0) {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
    lines.push("## ユーザー指示履歴", entryLine);
  } else {
    const sectionStart = sectionIndex + 1;
    let insertAt = sectionStart;

    while (insertAt < lines.length && !lines[insertAt]!.startsWith("## ")) {
      if (lines[insertAt]?.trim() === "- なし") {
        lines.splice(insertAt, 1);
        continue;
      }
      insertAt += 1;
    }

    if (insertAt > sectionStart && lines[insertAt - 1]?.trim() !== "") {
      lines.splice(insertAt, 0, "");
      insertAt += 1;
    }

    lines.splice(insertAt, 0, entryLine);
  }

  await writeFile(planFilePath, lines.join("\n"), "utf-8");
}

async function writeTaskPlan(planFilePath: string, content: string): Promise<void> {
  await mkdir(join(planFilePath, ".."), { recursive: true });
  await writeFile(planFilePath, content, "utf-8");
}

async function updateTaskPlanUnit(
  planFilePath: string,
  unitGoal: string,
  newStatus: TaskPlanStatus,
  extras?: {
    qualityScore?: number;
    findingsFile?: string;
    startedAt?: string;
    completedAt?: string;
  }
): Promise<void> {
  let content: string;
  try {
    content = await readFile(planFilePath, "utf-8");
  } catch {
    return;
  }

  const lines = content.split(/\r?\n/);
  const statusPattern = new RegExp(`^(\\s*)(-\\s*)(TODO|DOING|DONE)(\\s+\\[(?:L\\d-\\d+)\\]\\s+${escapeRegExp(unitGoal)}\\s*)$`);
  const lineIndex = lines.findIndex((line) => statusPattern.test(line));
  if (lineIndex < 0) {
    return;
  }

  const match = lines[lineIndex]!.match(statusPattern);
  if (!match) {
    return;
  }

  const indentPrefix = match[1] ?? "";
  const bulletPrefix = match[2] ?? "- ";
  lines[lineIndex] = `${indentPrefix}${bulletPrefix}${newStatus}${match[4] ?? ""}`;

  const extraLines: string[] = [];
  if (extras?.qualityScore !== undefined) {
    extraLines.push(`${indentPrefix}  - 品質スコア: ${extras.qualityScore}/100`);
  }
  if (extras?.findingsFile) {
    extraLines.push(`${indentPrefix}  - findingsFile: ${extras.findingsFile}`);
  }
  if (extras?.startedAt) {
    extraLines.push(`${indentPrefix}  - 開始時刻: ${extras.startedAt}`);
  }
  if (extras?.completedAt) {
    extraLines.push(`${indentPrefix}  - 完了時刻: ${extras.completedAt}`);
  }

  if (extraLines.length > 0) {
    let insertAt = lineIndex + 1;
    while (insertAt < lines.length) {
      const currentLine = lines[insertAt] ?? "";
      if (!currentLine.startsWith(`${indentPrefix}  - `)) {
        break;
      }
      if (!currentLine.match(/^\s{0,}(?:  )?-\s*(品質スコア|findingsFile|開始時刻|完了時刻):/)) {
        break;
      }
      lines.splice(insertAt, 1);
    }
    lines.splice(insertAt, 0, ...extraLines);
  }

  await writeFile(planFilePath, lines.join("\n"), "utf-8");
}

// ---------------------------------------------------------------------------

export interface DecomposedLoopOptions {
  task: string;
  managerAgent: Agent;
  callbacks: LoopCallbacks;
  auditLogger?: AuditLogger;
  notify?: (message: string) => void;
  maxIterationsPerUnit?: number;
  iterationTimeoutMs?: number;
  /** When set, WorkUnit completion state is persisted to {logsDir}/loop-state.json.
   *  This allows the orchestrator to resume mid-session without restarting from Unit 1. */
  logsDir?: string;
  taskPlanPath?: string;
  statusReporter?: LoopStatusReporter;
  waitForInterrupt?: () => InterruptWaiter;
  decomposeTaskFn?: typeof decomposeTask;
  synthesizeResultsFn?: typeof synthesizeResults;
  runPersistenceLoopFn?: typeof runPersistenceLoop;
}

export interface DecomposedLoopResult {
  synthesizedWorkProduct: string;
  workUnitResults: WorkUnitResult[];
  totalDurationMs: number;
  wasSingleUnit: boolean;
  wasInterrupted?: boolean;
}

function sumIterationDuration(results: IterationResult[]): number {
  return results.reduce((total, result) => total + result.latencyMs.totalMs, 0);
}

function lastResult(results: IterationResult[]): IterationResult | null {
  if (results.length === 0) {
    return null;
  }
  return results[results.length - 1] ?? null;
}

function averageScore(scores: number[]): number {
  if (scores.length === 0) {
    return 0;
  }
  return Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Update a single WorkUnit's status in the state file on disk. */
async function persistUnitCompletion(
  stateFilePath: string,
  taskNormalized: string,
  unitGoal: string,
  status: "complete" | "failed" | "timeout",
  result: WorkUnitResult
): Promise<void> {
  const state = await readLoopState(stateFilePath);
  // Guard: only update if the file belongs to the same task
  if (!state || state.taskNormalized !== taskNormalized) return;
  const entry = state.units.find((u) => u.goal === unitGoal);
  if (entry) {
    entry.status = status;
    entry.findings = result.findings;
    entry.remainingWork = result.remainingWork;
    entry.durationMs = result.durationMs;
  }
  await writeLoopState(stateFilePath, state);
}

export async function runDecomposedLoop(options: DecomposedLoopOptions): Promise<DecomposedLoopResult> {
  const startMs = Date.now();
  const runLoop = options.runPersistenceLoopFn ?? runPersistenceLoop;
  const decompose = options.decomposeTaskFn ?? decomposeTask;
  const synthesize = options.synthesizeResultsFn ?? synthesizeResults;

  const stateFilePath = options.logsDir ? join(options.logsDir, "loop-state.json") : undefined;
  const taskPlanPath = options.taskPlanPath ?? (options.logsDir ? join(dirname(options.logsDir), "task-plan.md") : undefined);
  const taskNormalized = normalizeTask(options.task);

  // ---------------------------------------------------------------------------
  // Try to restore WorkUnit state from a previous aborted session
  // ---------------------------------------------------------------------------
  let initialUnits: WorkUnit[];
  let savedState: LoopStateFile | null = null;
  let isResume = false;
  // Feedback carried from a modify interrupt during decompose/resplit/synthesize into next runLoop
  let pendingFeedback: string | undefined;

  if (stateFilePath) {
    savedState = await readLoopState(stateFilePath);
    if (savedState && savedState.taskNormalized === taskNormalized) {
      isResume = true;
      // Restore WorkUnits from state file so goals match exactly (no re-decomposition)
      initialUnits = savedState.units.map((s) =>
        createWorkUnit({ goal: s.goal, scope: s.scope, outOfScope: s.outOfScope, depth: s.depth, parentId: s.parentId ?? undefined })
      );
    } else {
      // Different task or no state → fresh decomposition
      const decomposeRaced = await withTimeoutAndInterrupt(
        (signal) => decompose(options.managerAgent, options.task, { signal }),
        undefined,
        options.waitForInterrupt,
        options.callbacks.onQueryManager
      );
      if (decomposeRaced.kind === "interrupt") {
        // Both stop and modify must return early (no units available to run)
        if (decomposeRaced.request.type === "modify") pendingFeedback = decomposeRaced.request.feedback;
        return { synthesizedWorkProduct: "", workUnitResults: [], totalDurationMs: Math.max(0, Date.now() - startMs), wasSingleUnit: false, wasInterrupted: true };
      }
      initialUnits = decomposeRaced.value;
      const plan = createDecompositionPlan(options.task, initialUnits);
      await options.auditLogger?.logDecomposition(plan);
      const newState: LoopStateFile = {
        taskNormalized,
        createdAt: new Date().toISOString(),
        units: initialUnits.map((u) => ({
          id: u.id, goal: u.goal, scope: u.scope, outOfScope: u.outOfScope,
          depth: u.depth, parentId: u.parentId, retryCount: 0,
          status: "pending", findings: "", remainingWork: [], durationMs: 0
        }))
      };
      await writeLoopState(stateFilePath, newState);
      savedState = newState;
    }
  } else {
    const decomposeRaced2 = await withTimeoutAndInterrupt(
      (signal) => decompose(options.managerAgent, options.task, { signal }),
      undefined,
      options.waitForInterrupt,
      options.callbacks.onQueryManager
    );
    if (decomposeRaced2.kind === "interrupt") {
      if (decomposeRaced2.request.type === "modify") pendingFeedback = decomposeRaced2.request.feedback;
      return { synthesizedWorkProduct: "", workUnitResults: [], totalDurationMs: Math.max(0, Date.now() - startMs), wasSingleUnit: false, wasInterrupted: true };
    }
    initialUnits = decomposeRaced2.value;
    const plan = createDecompositionPlan(options.task, initialUnits);
    await options.auditLogger?.logDecomposition(plan);
  }

  if (isResume && savedState) {
    const completedCount = savedState.units.filter((u) => u.status === "complete" || u.status === "failed" || u.status === "timeout").length;
    options.notify?.(
      `セッション再開: ${savedState.units.length}個のWorkUnitのうち${completedCount}個が完了済みです。未完了のWorkUnitから再開します。`
    );
  }

  if (taskPlanPath) {
    const existingTaskPlan = await readTaskPlan(taskPlanPath);
    if (!existingTaskPlan) {
      const planContent = buildTaskPlanContent(options.task, initialUnits, new Date().toISOString());
      await writeTaskPlan(taskPlanPath, planContent);
      options.notify?.("タスク計画を作成しました: task-plan.md");
    } else if (!isResume) {
      const existingRootTask = await readTaskPlanRootTask(taskPlanPath);
      if (existingRootTask && existingRootTask.trim() !== options.task.trim()) {
        await appendTaskPlanDirective(taskPlanPath, `追加指示: ${options.task}`);
        options.notify?.("タスク計画に追加指示を追記しました");
      }
    }

    if (isResume && savedState) {
      for (const saved of savedState.units) {
        if (saved.status === "complete" || saved.status === "failed" || saved.status === "timeout") {
          await updateTaskPlanUnit(taskPlanPath, saved.goal, "DONE", { qualityScore: 70 });
        }
      }
    }
  }

  // Single-unit passthrough (no decomposition needed)
  if (initialUnits.length === 1) {
    const unit = initialUnits[0]!;
    const displayTotal = 1;
    const startedCount = 1;
    if (taskPlanPath) {
      await updateTaskPlanUnit(taskPlanPath, unit.goal, "DOING", { startedAt: new Date().toISOString() });
    }
    options.statusReporter?.onWorkUnitStart?.(startedCount, displayTotal, unit.goal);
    const passthroughResults = await runLoop(options.task, options.callbacks, {
      maxIterations: options.maxIterationsPerUnit ?? 3,
      iterationTimeoutMs: options.iterationTimeoutMs
    });
    const final = lastResult(passthroughResults);
    unit.status = final?.outcome === "timeout" ? "timeout" : "complete";

    const singleResult: WorkUnitResult = {
      workUnit: unit,
      findings: final?.workProduct ?? "",
      remainingWork: [],
      durationMs: sumIterationDuration(passthroughResults)
    };

    if (taskPlanPath && final) {
      await updateTaskPlanUnit(taskPlanPath, unit.goal, "DONE", {
        qualityScore: final.evaluation.qualityScore,
        findingsFile: `output/wu-${unit.id}-findings.md`,
        completedAt: new Date().toISOString()
      });
    }

    if (final) {
      options.statusReporter?.onWorkUnitComplete?.(startedCount, displayTotal, unit.goal, final.evaluation.qualityScore, `output/wu-${unit.id}-findings.md`);
      options.notify?.(
        `[${startedCount}/${displayTotal}] ${unit.goal} 完了 (${final.evaluation.qualityScore}/100, ${formatDuration(singleResult.durationMs)}, output/wu-${unit.id}-findings.md)`
      );
    }

    if (stateFilePath) await deleteLoopState(stateFilePath);
    return {
      synthesizedWorkProduct: final?.workProduct ?? "",
      workUnitResults: [singleResult],
      totalDurationMs: Math.max(0, Date.now() - startMs),
      wasSingleUnit: true
    };
  }

  // ---------------------------------------------------------------------------
  // Build backlog and completed from saved state (resume) or from scratch
  // ---------------------------------------------------------------------------
  const completed: WorkUnitResult[] = [];
  const qualityScores: number[] = [];

  if (isResume && savedState) {
    for (const saved of savedState.units) {
      const unit = initialUnits.find((u) => u.goal === saved.goal);
      if (!unit) continue;
      if (saved.status === "complete" || saved.status === "failed" || saved.status === "timeout") {
        unit.status = saved.status;
        completed.push({
          workUnit: unit,
          findings: saved.findings,
          remainingWork: saved.remainingWork,
          durationMs: saved.durationMs
        });
        qualityScores.push(70); // approximate; original scores not persisted
      }
    }
  }

  const backlog: WorkUnit[] = initialUnits.filter(
    (u) => !completed.some((c) => c.workUnit.goal === u.goal)
  );
  let startedCount = completed.length;

  while (backlog.length > 0) {
    const unit = backlog.shift();
    if (!unit) {
      break;
    }

    startedCount += 1;
    const displayTotal = startedCount + backlog.length;
    options.notify?.(`[${startedCount}/${displayTotal}] ${unit.goal} を開始します`);
    await options.auditLogger?.logWorkUnitStart(unit, startedCount, displayTotal);

    unit.status = "in-progress";
    if (taskPlanPath) {
      await updateTaskPlanUnit(taskPlanPath, unit.goal, "DOING", { startedAt: new Date().toISOString() });
    }
    options.statusReporter?.onWorkUnitStart?.(startedCount, displayTotal, unit.goal);
    const loopResults = await runLoop(unit.goal, options.callbacks, {
      maxIterations: options.maxIterationsPerUnit ?? 3,
      iterationTimeoutMs: options.iterationTimeoutMs,
      ...(pendingFeedback ? { initialFeedback: pendingFeedback } : {})
    });
    pendingFeedback = undefined;

    const final = lastResult(loopResults);
    if (!final) {
      unit.status = "failed";
      continue;
    }

    if (final.outcome === "user-interrupted") {
      unit.status = "partial";
      return {
        synthesizedWorkProduct: completed[completed.length - 1]?.findings ?? "",
        workUnitResults: completed,
        totalDurationMs: Math.max(0, Date.now() - startMs),
        wasSingleUnit: false,
        wasInterrupted: true
      };
    }

    if (final.outcome === "timeout") {
      unit.status = "timeout";

      const canRetry = unit.retryCount < MAX_RETRIES_PER_UNIT;
      const canResplitByDepth = unit.depth < MAX_DECOMPOSITION_DEPTH;

      if (canRetry && canResplitByDepth) {
        unit.retryCount += 1;
        const resplitRaced = await withTimeoutAndInterrupt(
          (signal) => decompose(options.managerAgent, unit.goal, { signal }),
          undefined,
          options.waitForInterrupt,
          options.callbacks.onQueryManager
        );
        if (resplitRaced.kind === "interrupt") {
          if (resplitRaced.request.type === "stop") {
            return { synthesizedWorkProduct: completed[completed.length - 1]?.findings ?? "", workUnitResults: completed, totalDurationMs: Math.max(0, Date.now() - startMs), wasSingleUnit: false, wasInterrupted: true };
          }
          // modify or query-manager: skip the resplit, carry feedback forward to next unit
          if (resplitRaced.request.type === "modify") pendingFeedback = resplitRaced.request.feedback;
          unit.status = "failed";
          const failedNoResplit: WorkUnitResult = { workUnit: unit, findings: final.workProduct, remainingWork: [unit.goal], durationMs: sumIterationDuration(loopResults) };
          completed.push(failedNoResplit);
          qualityScores.push(final.evaluation.qualityScore);
          if (taskPlanPath) {
            await updateTaskPlanUnit(taskPlanPath, unit.goal, "DONE", { qualityScore: final.evaluation.qualityScore, completedAt: new Date().toISOString() });
          }
          options.statusReporter?.onWorkUnitComplete?.(startedCount, displayTotal, unit.goal, final.evaluation.qualityScore);
          continue;
        }
        const subUnits = resplitRaced.value;
        const childSpecs = subUnits.map((child) => ({
          goal: child.goal,
          scope: child.scope,
          outOfScope: child.outOfScope
        }));
        const children = resplitWorkUnit(unit, childSpecs);
        await options.auditLogger?.logResplit(unit, children, "WorkUnit timed out");
        backlog.push(...children);
        continue;
      }

      unit.status = "failed";
      const failedResult: WorkUnitResult = {
        workUnit: unit,
        findings: final.workProduct,
        remainingWork: [unit.goal],
        durationMs: sumIterationDuration(loopResults)
      };
      completed.push(failedResult);
      qualityScores.push(final.evaluation.qualityScore);
      await options.auditLogger?.logWorkUnitComplete(failedResult, final.evaluation.qualityScore);
      if (taskPlanPath) {
        await updateTaskPlanUnit(taskPlanPath, unit.goal, "DONE", { qualityScore: final.evaluation.qualityScore, completedAt: new Date().toISOString() });
      }
      options.statusReporter?.onWorkUnitComplete?.(startedCount, displayTotal, unit.goal, final.evaluation.qualityScore);
      if (stateFilePath) {
        await persistUnitCompletion(stateFilePath, taskNormalized, unit.goal, "timeout", failedResult);
      }
      options.notify?.(
        `[${startedCount}/${displayTotal}] ${unit.goal} 完了 (${final.evaluation.qualityScore}/100, ${formatDuration(failedResult.durationMs)}, output/wu-${unit.id}-findings.md)`
      );
      continue;
    }

    unit.status = "complete";
    const result: WorkUnitResult = {
      workUnit: unit,
      findings: final.workProduct,
      remainingWork: [],
      durationMs: sumIterationDuration(loopResults)
    };
    completed.push(result);
    qualityScores.push(final.evaluation.qualityScore);
    await options.auditLogger?.logWorkUnitComplete(result, final.evaluation.qualityScore);
    if (taskPlanPath) {
      await updateTaskPlanUnit(taskPlanPath, unit.goal, "DONE", {
        qualityScore: final.evaluation.qualityScore,
        findingsFile: `output/wu-${unit.id}-findings.md`,
        completedAt: new Date().toISOString()
      });
    }
    options.statusReporter?.onWorkUnitComplete?.(startedCount, displayTotal, unit.goal, final.evaluation.qualityScore, `output/wu-${unit.id}-findings.md`);
    if (stateFilePath) {
      await persistUnitCompletion(stateFilePath, taskNormalized, unit.goal, "complete", result);
    }
    options.notify?.(`[${startedCount}/${displayTotal}] ${unit.goal} 完了 (${final.evaluation.qualityScore}/100, ${formatDuration(result.durationMs)}, output/wu-${unit.id}-findings.md)`);
  }

  const synthesisStart = Date.now();
  const synthesizeRaced = await withTimeoutAndInterrupt(
    (signal) => synthesize(options.managerAgent, options.task, completed, { signal }),
    undefined,
    options.waitForInterrupt,
    options.callbacks.onQueryManager
  );
  if (synthesizeRaced.kind === "interrupt") {
    if (stateFilePath) await deleteLoopState(stateFilePath);
    return { synthesizedWorkProduct: completed[completed.length - 1]?.findings ?? "", workUnitResults: completed, totalDurationMs: Math.max(0, Date.now() - startMs), wasSingleUnit: false, wasInterrupted: true };
  }
  const synthesizedWorkProduct = synthesizeRaced.value;
  const synthesisDuration = Math.max(0, Date.now() - synthesisStart);
  await options.auditLogger?.logSynthesis(completed.length, averageScore(qualityScores), synthesisDuration);

  if (taskPlanPath) {
    const synthesisStamp = new Date().toISOString();
    const existingContent = await readFile(taskPlanPath, "utf-8").catch(() => "");
    const synthesisSection = [
      "",
      "## 合成完了",
      `- 完了時刻: ${synthesisStamp}`,
      `- WorkUnit数: ${completed.length}`
    ].join("\n");
    await writeTaskPlan(taskPlanPath, `${existingContent.trimEnd()}${synthesisSection}`);
  }

  // Clean up state file — the session is now complete
  if (stateFilePath) await deleteLoopState(stateFilePath);

  return {
    synthesizedWorkProduct,
    workUnitResults: completed,
    totalDurationMs: Math.max(0, Date.now() - startMs),
    wasSingleUnit: false
  };
}
