import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { IterationResult } from "./persistence-loop.js";
import { summarizeLatency } from "./latency-tracker.js";

function makeIteration(
  iteration: number,
  latency: { worker: number; evaluation: number; manager: number; total: number }
): IterationResult {
  return {
    iteration,
    workProduct: `work-${iteration}`,
    evaluation: {
      qualityScore: 70 + iteration,
      summary: `summary-${iteration}`,
      issues: []
    },
    improvements: [],
    latencyMs: {
      workerExecutionMs: latency.worker,
      evaluationMs: latency.evaluation,
      managerImprovementMs: latency.manager,
      totalMs: latency.total
    },
    outcome: "improvement-applied"
  };
}

describe("summarizeLatency", () => {
  it("calculates averages and identifies bottleneck", () => {
    const summary = summarizeLatency(
      [
        makeIteration(1, { worker: 100, evaluation: 60, manager: 30, total: 200 }),
        makeIteration(2, { worker: 120, evaluation: 70, manager: 20, total: 230 }),
        makeIteration(3, { worker: 110, evaluation: 65, manager: 25, total: 220 })
      ],
      210
    );

    assert.equal(summary.iterationCount, 3);
    assert.equal(summary.averageTotalMs, 650 / 3);
    assert.equal(summary.averageWorkerMs, 110);
    assert.equal(summary.averageEvaluationMs, 65);
    assert.equal(summary.averageManagerMs, 25);
    assert.equal(summary.bottleneck, "worker");
    assert.equal(summary.exceedsTarget, true);
  });

  it("detects increasing trend", () => {
    const summary = summarizeLatency(
      [
        makeIteration(1, { worker: 20, evaluation: 10, manager: 5, total: 50 }),
        makeIteration(2, { worker: 25, evaluation: 10, manager: 5, total: 60 }),
        makeIteration(3, { worker: 30, evaluation: 10, manager: 5, total: 90 }),
        makeIteration(4, { worker: 35, evaluation: 10, manager: 5, total: 100 })
      ],
      120
    );

    assert.equal(summary.trend, "increasing");
  });

  it("detects decreasing trend", () => {
    const summary = summarizeLatency(
      [
        makeIteration(1, { worker: 35, evaluation: 10, manager: 5, total: 100 }),
        makeIteration(2, { worker: 30, evaluation: 10, manager: 5, total: 90 }),
        makeIteration(3, { worker: 25, evaluation: 10, manager: 5, total: 60 }),
        makeIteration(4, { worker: 20, evaluation: 10, manager: 5, total: 50 })
      ],
      120
    );

    assert.equal(summary.trend, "decreasing");
  });

  it("detects stable trend", () => {
    const summary = summarizeLatency(
      [
        makeIteration(1, { worker: 20, evaluation: 10, manager: 5, total: 80 }),
        makeIteration(2, { worker: 20, evaluation: 10, manager: 5, total: 81 }),
        makeIteration(3, { worker: 20, evaluation: 10, manager: 5, total: 79 }),
        makeIteration(4, { worker: 20, evaluation: 10, manager: 5, total: 80 })
      ],
      100
    );

    assert.equal(summary.trend, "stable");
    assert.equal(summary.exceedsTarget, false);
  });
});
