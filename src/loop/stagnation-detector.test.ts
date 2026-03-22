import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { IterationResult } from "./persistence-loop.js";
import { detectStagnation } from "./stagnation-detector.js";

function makeIteration(iteration: number, qualityScore: number): IterationResult {
  return {
    iteration,
    workProduct: `work-${iteration}`,
    evaluation: {
      qualityScore,
      summary: `summary-${iteration}`,
      issues: []
    },
    improvements: [],
    latencyMs: {
      workerExecutionMs: 10,
      evaluationMs: 5,
      managerImprovementMs: 3,
      totalMs: 18
    },
    outcome: "improvement-applied"
  };
}

describe("detectStagnation", () => {
  it("detects stagnation when scores plateau", () => {
    const result = detectStagnation([
      makeIteration(1, 70),
      makeIteration(2, 71),
      makeIteration(3, 72),
      makeIteration(4, 72)
    ]);

    assert.equal(result.isStagnant, true);
    assert.equal(result.consecutiveNonImprovements, 2);
    assert.deepEqual(result.scoreTrend, [71, 72, 72]);
  });

  it("does not flag stagnation when scores are improving", () => {
    const result = detectStagnation([
      makeIteration(1, 70),
      makeIteration(2, 72),
      makeIteration(3, 74),
      makeIteration(4, 76)
    ]);

    assert.equal(result.isStagnant, false);
    assert.equal(result.consecutiveNonImprovements, 0);
    assert.deepEqual(result.scoreTrend, [72, 74, 76]);
  });

  it("respects windowSize parameter", () => {
    const result = detectStagnation(
      [
        makeIteration(1, 60),
        makeIteration(2, 64),
        makeIteration(3, 66),
        makeIteration(4, 66),
        makeIteration(5, 66)
      ],
      { windowSize: 2 }
    );

    assert.equal(result.isStagnant, true);
    assert.equal(result.consecutiveNonImprovements, 1);
    assert.deepEqual(result.scoreTrend, [66, 66]);
  });

  it("handles insufficient data", () => {
    const result = detectStagnation([makeIteration(1, 75)]);

    assert.equal(result.isStagnant, false);
    assert.equal(result.consecutiveNonImprovements, 0);
    assert.deepEqual(result.scoreTrend, [75]);
  });
});
