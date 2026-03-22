import type { IterationResult } from "./persistence-loop.js";

export interface RollbackConfig {
  consecutiveDegradationThreshold: number;
}

export interface RollbackDecision {
  shouldRollback: boolean;
  consecutiveDegradations: number;
  lastGoodIteration: number | null;
  reason: string;
}

const defaultConfig: RollbackConfig = {
  consecutiveDegradationThreshold: 3
};

export function evaluateRollback(
  results: IterationResult[],
  config?: Partial<RollbackConfig>
): RollbackDecision {
  const mergedConfig: RollbackConfig = { ...defaultConfig, ...config };

  if (results.length < 2) {
    return {
      shouldRollback: false,
      consecutiveDegradations: 0,
      lastGoodIteration: null,
      reason: "Not enough iterations to evaluate rollback."
    };
  }

  let lastGoodIteration: number | null = null;
  for (let index = 1; index < results.length; index += 1) {
    const previous = results[index - 1]!.evaluation.qualityScore;
    const current = results[index]!.evaluation.qualityScore;
    if (current > previous) {
      lastGoodIteration = results[index]!.iteration;
    }
  }

  let consecutiveDegradations = 0;
  for (let index = results.length - 1; index > 0; index -= 1) {
    const previous = results[index - 1]!.evaluation.qualityScore;
    const current = results[index]!.evaluation.qualityScore;
    if (current < previous) {
      consecutiveDegradations += 1;
      continue;
    }
    break;
  }

  const shouldRollback = consecutiveDegradations >= mergedConfig.consecutiveDegradationThreshold;
  const reason = shouldRollback
    ? `Detected ${consecutiveDegradations} consecutive quality degradations.`
    : "No sustained degradation pattern requiring rollback.";

  return {
    shouldRollback,
    consecutiveDegradations,
    lastGoodIteration,
    reason
  };
}
