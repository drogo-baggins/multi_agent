import type { IterationResult } from "./persistence-loop.js";

export interface StagnationConfig {
  windowSize: number;
  minImprovementThreshold: number;
}

export interface StagnationResult {
  isStagnant: boolean;
  consecutiveNonImprovements: number;
  scoreTrend: number[];
  recommendation: string;
}

const defaultConfig: StagnationConfig = {
  windowSize: 3,
  minImprovementThreshold: 2
};

export function detectStagnation(
  results: IterationResult[],
  config?: Partial<StagnationConfig>
): StagnationResult {
  const mergedConfig: StagnationConfig = { ...defaultConfig, ...config };
  const scores = results.map((result) => result.evaluation.qualityScore);
  const scoreTrend = scores.slice(-Math.max(1, mergedConfig.windowSize));

  if (scoreTrend.length < 2) {
    return {
      isStagnant: false,
      consecutiveNonImprovements: 0,
      scoreTrend,
      recommendation: "Not enough iterations to assess stagnation."
    };
  }

  let hasMeaningfulImprovement = false;
  for (let index = 1; index < scoreTrend.length; index += 1) {
    if (scoreTrend[index]! - scoreTrend[index - 1]! >= mergedConfig.minImprovementThreshold) {
      hasMeaningfulImprovement = true;
      break;
    }
  }

  let consecutiveNonImprovements = 0;
  for (let index = scoreTrend.length - 1; index > 0; index -= 1) {
    if (scoreTrend[index]! - scoreTrend[index - 1]! >= mergedConfig.minImprovementThreshold) {
      break;
    }
    consecutiveNonImprovements += 1;
  }

  const isStagnant = !hasMeaningfulImprovement;
  const recommendation = isStagnant
    ? "Quality appears stagnant. Consider stronger prompt/config adjustments."
    : "Quality is improving. Continue current improvement cycle.";

  return {
    isStagnant,
    consecutiveNonImprovements,
    scoreTrend,
    recommendation
  };
}
