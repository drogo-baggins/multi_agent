import type { Agent } from "@mariozechner/pi-agent-core";
import { readFile, writeFile, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { decomposeTask, resplitWorkUnit } from "./task-decomposer.js";
import { synthesizeResults } from "./result-synthesizer.js";
import {
  MAX_DECOMPOSITION_DEPTH,
  MAX_RETRIES_PER_UNIT,
  createDecompositionPlan,
  createWorkUnit,
  type WorkUnit,
  type WorkUnitResult
} from "./work-unit.js";
import type { AuditLogger } from "./manager-audit-log.js";
import type { LoopCallbacks, IterationResult, InterruptRequest } from "./persistence-loop.js";
import { runPersistenceLoop } from "./persistence-loop.js";

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
  waitForInterrupt?: () => Promise<InterruptRequest>;
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

/** Race a task factory against an optional interrupt channel.
 *  When the interrupt wins, aborts the underlying operation via AbortController
 *  and returns the full InterruptRequest so callers can distinguish stop vs modify.
 *  Handles a single query-manager interrupt inline: queries the manager and re-races. */
async function raceOrResolve<T>(
  taskFn: (signal: AbortSignal) => Promise<T>,
  waitForInterrupt: (() => Promise<InterruptRequest>) | undefined,
  onQueryManager?: (question: string) => Promise<string>
): Promise<{ kind: "value"; value: T } | { kind: "interrupt"; request: InterruptRequest }> {
  const controller = new AbortController();
  const promise = taskFn(controller.signal);
  // Suppress unhandled-rejection warnings if we abort before the promise resolves
  void promise.catch(() => undefined);
  if (!waitForInterrupt) {
    return { kind: "value", value: await promise };
  }
  const interruptP = waitForInterrupt();
  void interruptP.catch(() => undefined);
  const result = await Promise.race([
    promise.then((v) => ({ kind: "value" as const, value: v })),
    interruptP.then((request) => ({ kind: "interrupt" as const, request }))
  ]);
  if (result.kind === "interrupt") {
    if (result.request.type === "query-manager") {
      await onQueryManager?.(result.request.question);
      const newInterruptP = waitForInterrupt();
      void newInterruptP.catch(() => undefined);
      return Promise.race([
        promise.then((v) => ({ kind: "value" as const, value: v })),
        newInterruptP.then((request) => ({ kind: "interrupt" as const, request }))
      ]);
    }
    controller.abort();
  }
  return result;
}

export async function runDecomposedLoop(options: DecomposedLoopOptions): Promise<DecomposedLoopResult> {
  const startMs = Date.now();
  const runLoop = options.runPersistenceLoopFn ?? runPersistenceLoop;
  const decompose = options.decomposeTaskFn ?? decomposeTask;
  const synthesize = options.synthesizeResultsFn ?? synthesizeResults;

  const stateFilePath = options.logsDir ? join(options.logsDir, "loop-state.json") : undefined;
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
      const decomposeRaced = await raceOrResolve(
        (signal) => decompose(options.managerAgent, options.task, { signal }),
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
    const decomposeRaced2 = await raceOrResolve(
      (signal) => decompose(options.managerAgent, options.task, { signal }),
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

  // Single-unit passthrough (no decomposition needed)
  if (initialUnits.length === 1) {
    const passthroughResults = await runLoop(options.task, options.callbacks, {
      maxIterations: options.maxIterationsPerUnit ?? 3,
      iterationTimeoutMs: options.iterationTimeoutMs
    });
    const final = lastResult(passthroughResults);
    const unit = initialUnits[0]!;
    unit.status = final?.outcome === "timeout" ? "timeout" : "complete";

    const singleResult: WorkUnitResult = {
      workUnit: unit,
      findings: final?.workProduct ?? "",
      remainingWork: [],
      durationMs: sumIterationDuration(passthroughResults)
    };

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
        const resplitRaced = await raceOrResolve(
          (signal) => decompose(options.managerAgent, unit.goal, { signal }),
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
      if (stateFilePath) {
        await persistUnitCompletion(stateFilePath, taskNormalized, unit.goal, "timeout", failedResult);
      }
      options.notify?.(
        `[${startedCount}/${displayTotal}] ${unit.goal} 完了 (${final.evaluation.qualityScore}/100, ${formatDuration(failedResult.durationMs)})`
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
    if (stateFilePath) {
      await persistUnitCompletion(stateFilePath, taskNormalized, unit.goal, "complete", result);
    }
    options.notify?.(`[${startedCount}/${displayTotal}] ${unit.goal} 完了 (${final.evaluation.qualityScore}/100, ${formatDuration(result.durationMs)})`);
  }

  const synthesisStart = Date.now();
  const synthesizeRaced = await raceOrResolve(
    (signal) => synthesize(options.managerAgent, options.task, completed, { signal }),
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

  // Clean up state file — the session is now complete
  if (stateFilePath) await deleteLoopState(stateFilePath);

  return {
    synthesizedWorkProduct,
    workUnitResults: completed,
    totalDurationMs: Math.max(0, Date.now() - startMs),
    wasSingleUnit: false
  };
}
