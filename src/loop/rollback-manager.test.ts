import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { IterationResult } from "./persistence-loop.js";
import { evaluateRollback } from "./rollback-manager.js";

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

describe("evaluateRollback", () => {
  it("recommends rollback after N consecutive degradations", () => {
    const decision = evaluateRollback(
      [
        makeIteration(1, 80),
        makeIteration(2, 78),
        makeIteration(3, 76),
        makeIteration(4, 74)
      ],
      { consecutiveDegradationThreshold: 3 }
    );

    assert.equal(decision.shouldRollback, true);
    assert.equal(decision.consecutiveDegradations, 3);
  });

  it("does not recommend rollback when scores are mixed", () => {
    const decision = evaluateRollback(
      [
        makeIteration(1, 80),
        makeIteration(2, 78),
        makeIteration(3, 81),
        makeIteration(4, 79)
      ],
      { consecutiveDegradationThreshold: 2 }
    );

    assert.equal(decision.shouldRollback, false);
    assert.equal(decision.consecutiveDegradations, 1);
  });

  it("identifies the last good iteration", () => {
    const decision = evaluateRollback(
      [
        makeIteration(1, 70),
        makeIteration(2, 75),
        makeIteration(3, 74),
        makeIteration(4, 73),
        makeIteration(5, 72)
      ],
      { consecutiveDegradationThreshold: 3 }
    );

    assert.equal(decision.shouldRollback, true);
    assert.equal(decision.lastGoodIteration, 2);
  });

  it("handles edge cases", () => {
    const single = evaluateRollback([makeIteration(1, 70)]);
    assert.equal(single.shouldRollback, false);
    assert.equal(single.consecutiveDegradations, 0);
    assert.equal(single.lastGoodIteration, null);

    const noDegradation = evaluateRollback([
      makeIteration(1, 70),
      makeIteration(2, 71),
      makeIteration(3, 72)
    ]);
    assert.equal(noDegradation.shouldRollback, false);
    assert.equal(noDegradation.consecutiveDegradations, 0);
    assert.equal(noDegradation.lastGoodIteration, 3);
  });
});
