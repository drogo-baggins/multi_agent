import type { Agent } from "@mariozechner/pi-agent-core";

import { decomposeTask, resplitWorkUnit } from "./task-decomposer.js";
import { synthesizeResults } from "./result-synthesizer.js";
import {
  MAX_DECOMPOSITION_DEPTH,
  MAX_RETRIES_PER_UNIT,
  createDecompositionPlan,
  type WorkUnit,
  type WorkUnitResult
} from "./work-unit.js";
import type { AuditLogger } from "./manager-audit-log.js";
import type { LoopCallbacks, IterationResult } from "./persistence-loop.js";
import { runPersistenceLoop } from "./persistence-loop.js";

export interface DecomposedLoopOptions {
  task: string;
  managerAgent: Agent;
  callbacks: LoopCallbacks;
  auditLogger?: AuditLogger;
  notify?: (message: string) => void;
  maxIterationsPerUnit?: number;
  iterationTimeoutMs?: number;
  decomposeTaskFn?: typeof decomposeTask;
  synthesizeResultsFn?: typeof synthesizeResults;
  runPersistenceLoopFn?: typeof runPersistenceLoop;
}

export interface DecomposedLoopResult {
  synthesizedWorkProduct: string;
  workUnitResults: WorkUnitResult[];
  totalDurationMs: number;
  wasSingleUnit: boolean;
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

export async function runDecomposedLoop(options: DecomposedLoopOptions): Promise<DecomposedLoopResult> {
  const startMs = Date.now();
  const runLoop = options.runPersistenceLoopFn ?? runPersistenceLoop;
  const decompose = options.decomposeTaskFn ?? decomposeTask;
  const synthesize = options.synthesizeResultsFn ?? synthesizeResults;

  const initialUnits = await decompose(options.managerAgent, options.task);
  const decompositionPlan = createDecompositionPlan(options.task, initialUnits);
  await options.auditLogger?.logDecomposition(decompositionPlan);

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

    return {
      synthesizedWorkProduct: final?.workProduct ?? "",
      workUnitResults: [singleResult],
      totalDurationMs: Math.max(0, Date.now() - startMs),
      wasSingleUnit: true
    };
  }

  const backlog: WorkUnit[] = [...initialUnits];
  const completed: WorkUnitResult[] = [];
  const qualityScores: number[] = [];
  let startedCount = 0;

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
      iterationTimeoutMs: options.iterationTimeoutMs
    });

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
        wasSingleUnit: false
      };
    }

    if (final.outcome === "timeout") {
      unit.status = "timeout";

      const canRetry = unit.retryCount < MAX_RETRIES_PER_UNIT;
      const canResplitByDepth = unit.depth < MAX_DECOMPOSITION_DEPTH;

      if (canRetry && canResplitByDepth) {
        unit.retryCount += 1;
        const subUnits = await decompose(options.managerAgent, unit.goal);
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
    options.notify?.(`[${startedCount}/${displayTotal}] ${unit.goal} 完了 (${final.evaluation.qualityScore}/100, ${formatDuration(result.durationMs)})`);
  }

  const synthesisStart = Date.now();
  const synthesizedWorkProduct = await synthesize(options.managerAgent, options.task, completed);
  const synthesisDuration = Math.max(0, Date.now() - synthesisStart);
  await options.auditLogger?.logSynthesis(completed.length, averageScore(qualityScores), synthesisDuration);

  return {
    synthesizedWorkProduct,
    workUnitResults: completed,
    totalDurationMs: Math.max(0, Date.now() - startMs),
    wasSingleUnit: false
  };
}
