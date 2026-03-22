import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatEvaluationReport,
  parseEvaluationReport,
  type EvaluationReport
} from "./evaluation-report.js";
import {
  buildImprovementRequests,
  formatImprovementRequest
} from "./improvement-request.js";
import {
  runPersistenceLoop,
  type LoopCallbacks,
  type UserFeedback,
  type WorkerContext
} from "./persistence-loop.js";

function createReport(overrides?: Partial<EvaluationReport>): EvaluationReport {
  return {
    qualityScore: 72,
    summary: "Needs tighter structure and broader coverage.",
    issues: [
      {
        category: "coverage",
        description: "Misses one major section",
        evidence: "No section for deployment constraints.",
        cause: "config"
      }
    ],
    ...overrides
  };
}

function createCallbacks(params: {
  feedbackSequence: UserFeedback[];
  reportFactory?: (iteration: number) => EvaluationReport;
  workerFactory?: (iteration: number) => string;
  improvementsFactory?: (iteration: number) => string[];
  onImprovementRequests?: (count: number) => void;
  onIterationComplete?: (iteration: number) => void;
}): LoopCallbacks {
  let workerCount = 0;
  let evaluationCount = 0;
  let improvementCount = 0;
  let feedbackIndex = 0;

  return {
    executeWorker: async (_task: string, _context?: WorkerContext) => {
      workerCount += 1;
      return params.workerFactory?.(workerCount) ?? `work-${workerCount}`;
    },
    evaluateProduct: async () => {
      evaluationCount += 1;
      return params.reportFactory?.(evaluationCount) ?? createReport();
    },
    getUserFeedback: async () => {
      const feedback = params.feedbackSequence[feedbackIndex];
      feedbackIndex += 1;
      return feedback ?? { type: "approved" };
    },
    executeImprovement: async (requests) => {
      improvementCount += 1;
      params.onImprovementRequests?.(requests.length);
      return params.improvementsFactory?.(improvementCount) ?? [`improvement-${improvementCount}`];
    },
    onIterationComplete: () => {
      params.onIterationComplete?.(workerCount);
    },
    readCurrentConfig: async () => "# config\n- keep sections complete"
  };
}

describe("runPersistenceLoop", () => {
  it("runs single iteration when user approves first result", async () => {
    let completedCount = 0;
    let improvementCalls = 0;

    const callbacks = createCallbacks({
      feedbackSequence: [{ type: "approved" }],
      onIterationComplete: () => {
        completedCount += 1;
      },
      onImprovementRequests: () => {
        improvementCalls += 1;
      }
    });

    const results = await runPersistenceLoop("task", callbacks);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.iteration, 1);
    assert.equal(results[0]?.outcome, "user-approved");
    assert.deepEqual(results[0]?.improvements, []);
    assert.equal(completedCount, 1);
    assert.equal(improvementCalls, 0);
  });

  it("runs multiple iterations when user requests improvements", async () => {
    const requestCounts: number[] = [];
    const callbacks = createCallbacks({
      feedbackSequence: [
        { type: "improve", feedback: "Please fix coverage." },
        { type: "approved" }
      ],
      onImprovementRequests: (count) => {
        requestCounts.push(count);
      },
      reportFactory: () => createReport()
    });

    const results = await runPersistenceLoop("task", callbacks);

    assert.equal(results.length, 2);
    assert.equal(results[0]?.outcome, "improvement-applied");
    assert.equal(results[1]?.outcome, "user-approved");
    assert.deepEqual(requestCounts, [1]);
    assert.deepEqual(results[0]?.improvements, ["improvement-1"]);
  });

  it("stops at max iterations", async () => {
    const callbacks = createCallbacks({
      feedbackSequence: [
        { type: "improve", feedback: "again" },
        { type: "improve", feedback: "again" },
        { type: "improve", feedback: "again" }
      ]
    });

    const results = await runPersistenceLoop("task", callbacks, { maxIterations: 2 });

    assert.equal(results.length, 2);
    assert.equal(results[0]?.outcome, "improvement-applied");
    assert.equal(results[1]?.outcome, "max-iterations");
  });

  it("stops on user interrupt", async () => {
    const callbacks = createCallbacks({
      feedbackSequence: [{ type: "interrupt" }]
    });

    const results = await runPersistenceLoop("task", callbacks);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.outcome, "user-interrupted");
    assert.deepEqual(results[0]?.improvements, []);
  });

  it("records latency for each iteration", async () => {
    const callbacks = createCallbacks({
      feedbackSequence: [{ type: "approved" }]
    });

    const results = await runPersistenceLoop("task", callbacks);
    const latency = results[0]?.latencyMs;

    assert.ok(latency);
    assert.equal(latency.workerExecutionMs >= 0, true);
    assert.equal(latency.evaluationMs >= 0, true);
    assert.equal(latency.managerImprovementMs >= 0, true);
    assert.equal(latency.totalMs >= latency.workerExecutionMs + latency.evaluationMs, true);
  });

  it("calls onIterationComplete with intermediate reporting data", async () => {
    const captured: Array<{ iteration: number; outcome: string; improvements: string[] }> = [];
    const callbacks = createCallbacks({
      feedbackSequence: [
        { type: "improve", feedback: "tighten structure" },
        { type: "approved" }
      ],
      onIterationComplete: () => {}
    });

    const wrapped: LoopCallbacks = {
      ...callbacks,
      onIterationComplete: (result) => {
        captured.push({
          iteration: result.iteration,
          outcome: result.outcome,
          improvements: result.improvements
        });
      }
    };

    await runPersistenceLoop("task", wrapped);

    assert.deepEqual(captured.map((entry) => entry.iteration), [1, 2]);
    assert.equal(captured[0]?.outcome, "improvement-applied");
    assert.equal(captured[1]?.outcome, "user-approved");
    assert.deepEqual(captured[0]?.improvements, ["improvement-1"]);
  });
});

describe("evaluation report formatting and parsing", () => {
  it("supports format/parse roundtrip", () => {
    const report = createReport({
      qualityScore: 88,
      summary: "Solid output with one citation gap.",
      issues: [
        {
          category: "citations",
          description: "Claim lacks source",
          evidence: "Market size doubled in 2 years.",
          cause: "config"
        },
        {
          category: "structure",
          description: "Conclusion is abrupt",
          evidence: "Ends without recommendations.",
          cause: "task-difficulty"
        }
      ]
    });

    const formatted = formatEvaluationReport(report);
    const parsed = parseEvaluationReport(formatted);

    assert.equal(parsed.qualityScore, 88);
    assert.equal(parsed.summary.includes("Solid output"), true);
    assert.equal(parsed.issues.length, 2);
    assert.equal(parsed.issues[0]?.category, "citations");
    assert.equal(parsed.issues[1]?.cause, "task-difficulty");
  });
});

describe("improvement requests", () => {
  it("builds one request per config-attributed issue", () => {
    const report = createReport({
      issues: [
        {
          category: "coverage",
          description: "Missing risk section",
          evidence: "No risk analysis subsection.",
          cause: "config"
        },
        {
          category: "accuracy",
          description: "Ambiguous metric",
          evidence: "States growth without baseline.",
          cause: "llm-limitation"
        }
      ]
    });

    const requests = buildImprovementRequests(
      report,
      "Work product body includes No risk analysis subsection.",
      "# APPEND_SYSTEM\nEnsure risk analysis section is mandatory.",
      "Please improve reliability."
    );

    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.issueCategory, "coverage");
    assert.equal(requests[0]?.userFeedback, "Please improve reliability.");

    const formatted = formatImprovementRequest(requests[0]!);
    assert.equal(formatted.includes("## Issue Category and Evidence"), true);
    assert.equal(formatted.includes("## Related Config Section"), true);
  });
});
