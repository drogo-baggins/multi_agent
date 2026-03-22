import type { IterationResult } from "./persistence-loop.js";

export interface LatencySummary {
  iterationCount: number;
  averageTotalMs: number;
  averageWorkerMs: number;
  averageEvaluationMs: number;
  averageManagerMs: number;
  bottleneck: "worker" | "evaluation" | "manager";
  trend: "increasing" | "decreasing" | "stable";
  exceedsTarget: boolean;
  targetMs: number;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sum = values.reduce((total, value) => total + value, 0);
  return sum / values.length;
}

export function summarizeLatency(results: IterationResult[], targetIterationMs: number): LatencySummary {
  const workerValues = results.map((result) => result.latencyMs.workerExecutionMs);
  const evaluationValues = results.map((result) => result.latencyMs.evaluationMs);
  const managerValues = results.map((result) => result.latencyMs.managerImprovementMs);
  const totalValues = results.map((result) => result.latencyMs.totalMs);

  const averageWorkerMs = average(workerValues);
  const averageEvaluationMs = average(evaluationValues);
  const averageManagerMs = average(managerValues);
  const averageTotalMs = average(totalValues);

  let bottleneck: "worker" | "evaluation" | "manager" = "worker";
  if (averageEvaluationMs > averageWorkerMs && averageEvaluationMs >= averageManagerMs) {
    bottleneck = "evaluation";
  }
  if (averageManagerMs > averageWorkerMs && averageManagerMs > averageEvaluationMs) {
    bottleneck = "manager";
  }

  const splitIndex = Math.max(1, Math.floor(totalValues.length / 2));
  const firstHalf = totalValues.slice(0, splitIndex);
  const secondHalf = totalValues.slice(splitIndex);
  const firstHalfAvg = average(firstHalf);
  const secondHalfAvg = average(secondHalf.length > 0 ? secondHalf : firstHalf);

  let trend: "increasing" | "decreasing" | "stable" = "stable";
  const delta = secondHalfAvg - firstHalfAvg;
  if (delta > 1) {
    trend = "increasing";
  } else if (delta < -1) {
    trend = "decreasing";
  }

  return {
    iterationCount: results.length,
    averageTotalMs,
    averageWorkerMs,
    averageEvaluationMs,
    averageManagerMs,
    bottleneck,
    trend,
    exceedsTarget: averageTotalMs > targetIterationMs,
    targetMs: targetIterationMs
  };
}
