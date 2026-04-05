import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import type { Agent } from "@mariozechner/pi-agent-core";

import type { AuditLogger } from "./manager-audit-log.js";
import type { IterationResult, LoopCallbacks } from "./persistence-loop.js";
import { runDecomposedLoop } from "./task-orchestrator.js";
import { MAX_DECOMPOSITION_DEPTH, createWorkUnit, type WorkUnit, type WorkUnitResult } from "./work-unit.js";

function createIterationResult(params: {
  workProduct: string;
  outcome?: IterationResult["outcome"];
  qualityScore?: number;
  totalMs?: number;
}): IterationResult {
  return {
    iteration: 1,
    workProduct: params.workProduct,
    evaluation: {
      qualityScore: params.qualityScore ?? 80,
      summary: "good",
      issues: []
    },
    improvements: [],
    latencyMs: {
      workerExecutionMs: 100,
      evaluationMs: 20,
      managerImprovementMs: 0,
      totalMs: params.totalMs ?? 120
    },
    outcome: params.outcome ?? "user-approved"
  };
}

function createCallbacks(): LoopCallbacks {
  return {
    executeWorker: async () => "",
    evaluateProduct: async () => ({ qualityScore: 80, summary: "", issues: [] }),
    getUserFeedback: async () => ({ type: "approved" }),
    executeImprovement: async () => [],
    onIterationComplete: () => {},
    readCurrentConfig: async () => ""
  };
}

function createAuditLoggerMocks(): {
  logger: AuditLogger;
  logDecomposition: ReturnType<typeof mock.fn>;
  logWorkUnitStart: ReturnType<typeof mock.fn>;
  logWorkUnitComplete: ReturnType<typeof mock.fn>;
  logResplit: ReturnType<typeof mock.fn>;
  logSynthesis: ReturnType<typeof mock.fn>;
} {
  const logDecomposition = mock.fn(async () => {});
  const logWorkUnitStart = mock.fn(async () => {});
  const logWorkUnitComplete = mock.fn(async () => {});
  const logResplit = mock.fn(async () => {});
  const logSynthesis = mock.fn(async () => {});

  return {
    logger: {
      logIteration: async () => {},
      logDecomposition,
      logWorkUnitStart,
      logWorkUnitComplete,
      logResplit,
      logSynthesis
    },
    logDecomposition,
    logWorkUnitStart,
    logWorkUnitComplete,
    logResplit,
    logSynthesis
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe("runDecomposedLoop", () => {
  it("single-unit passthrough runs persistence loop once with original task", async () => {
    const unit = createWorkUnit({ goal: "Part A", scope: "A" });
    const runLoop = mock.fn(async () => [createIterationResult({ workProduct: "single-product" })]);

    const result = await runDecomposedLoop({
      task: "Original Task",
      managerAgent: {} as Agent,
      callbacks: createCallbacks(),
      decomposeTaskFn: async () => [unit],
      runPersistenceLoopFn: runLoop,
      synthesizeResultsFn: async () => "should-not-be-used"
    });

    assert.equal(runLoop.mock.calls.length, 1);
    assert.equal(runLoop.mock.calls[0]?.arguments[0], "Original Task");
    assert.equal(result.wasSingleUnit, true);
    assert.equal(result.synthesizedWorkProduct, "single-product");
    assert.equal(result.workUnitResults.length, 1);
  });

  it("multi-unit executes sequentially and calls synthesis", async () => {
    const units = [
      createWorkUnit({ goal: "Part A", scope: "A" }),
      createWorkUnit({ goal: "Part B", scope: "B" }),
      createWorkUnit({ goal: "Part C", scope: "C" })
    ];

    const runLoop = mock.fn(async (task: string) => [createIterationResult({ workProduct: `result:${task}` })]);
    const synthesize = mock.fn(async (_agent: Agent, _task: string, results: WorkUnitResult[]) => `SYNTH:${results.length}`);

    const result = await runDecomposedLoop({
      task: "Main Task",
      managerAgent: {} as Agent,
      callbacks: createCallbacks(),
      decomposeTaskFn: async () => units,
      runPersistenceLoopFn: runLoop,
      synthesizeResultsFn: synthesize
    });

    assert.equal(runLoop.mock.calls.length, 3);
    assert.equal(runLoop.mock.calls[0]?.arguments[0], "Part A");
    assert.equal(runLoop.mock.calls[1]?.arguments[0], "Part B");
    assert.equal(runLoop.mock.calls[2]?.arguments[0], "Part C");
    assert.equal(result.workUnitResults.length, 3);
    assert.equal(synthesize.mock.calls.length, 1);
    assert.equal(result.synthesizedWorkProduct, "SYNTH:3");
    assert.equal(result.wasSingleUnit, false);
  });

  it("single-unit passthrough reports WorkUnit start and completion details", async () => {
    const unit = createWorkUnit({ goal: "Single unit", scope: "A" });
    const runLoop = mock.fn(async () => [createIterationResult({ workProduct: "single-product", qualityScore: 92, totalMs: 345 })]);
    const notifications: string[] = [];
    const onWorkUnitStart = mock.fn(() => {});
    const onWorkUnitComplete = mock.fn(() => {});

    const result = await runDecomposedLoop({
      task: "Original Task",
      managerAgent: {} as Agent,
      callbacks: createCallbacks(),
      decomposeTaskFn: async () => [unit],
      runPersistenceLoopFn: runLoop,
      synthesizeResultsFn: async () => "should-not-be-used",
      notify: (message: string) => {
        notifications.push(message);
      },
      statusReporter: {
        onWorkerStart: () => {},
        onEvaluationStart: () => {},
        onFeedbackWaiting: () => {},
        onImprovementStart: () => {},
        onLoopComplete: () => {},
        onLoopInterrupted: () => {},
        onWorkUnitStart,
        onWorkUnitComplete
      }
    });

    assert.equal(onWorkUnitStart.mock.calls.length, 1);
    assert.equal(onWorkUnitStart.mock.calls[0]?.arguments[0], 1);
    assert.equal(onWorkUnitStart.mock.calls[0]?.arguments[1], 1);
    assert.equal(onWorkUnitStart.mock.calls[0]?.arguments[2], "Single unit");

    assert.equal(onWorkUnitComplete.mock.calls.length, 1);
    assert.equal(onWorkUnitComplete.mock.calls[0]?.arguments[0], 1);
    assert.equal(onWorkUnitComplete.mock.calls[0]?.arguments[1], 1);
    assert.equal(onWorkUnitComplete.mock.calls[0]?.arguments[2], "Single unit");
    assert.equal(onWorkUnitComplete.mock.calls[0]?.arguments[3], 92);
    assert.equal(onWorkUnitComplete.mock.calls[0]?.arguments[4], `output/wu-${unit.id}-findings.md`);

    assert.equal(notifications.some((message) => message.includes("[1/1] Single unit 完了") && message.includes("92/100") && message.includes("345ms") && message.includes(`output/wu-${unit.id}-findings.md`)), true);
    assert.equal(result.wasSingleUnit, true);
  });

  it("timeout triggers resplit and adds children to backlog", async () => {
    const parent = createWorkUnit({ goal: "Big unit", scope: "All" });
    const sibling = createWorkUnit({ goal: "Sibling", scope: "Other" });

    const decompose = mock.fn(async (_agent: Agent, task: string) => {
      if (task === "Main") {
        return [parent, sibling];
      }
      if (task === "Big unit") {
        return [
          createWorkUnit({ goal: "Child 1", scope: "Sub 1" }),
          createWorkUnit({ goal: "Child 2", scope: "Sub 2" })
        ];
      }
      return [];
    });

    const runLoop = mock.fn(async (task: string) => {
      if (task === "Big unit") {
        return [createIterationResult({ workProduct: "timeout-product", outcome: "timeout" })];
      }
      return [createIterationResult({ workProduct: `ok:${task}` })];
    });

    const result = await runDecomposedLoop({
      task: "Main",
      managerAgent: {} as Agent,
      callbacks: createCallbacks(),
      decomposeTaskFn: decompose,
      runPersistenceLoopFn: runLoop,
      synthesizeResultsFn: async () => "done"
    });

    assert.equal(decompose.mock.calls.length, 2);
    assert.equal(runLoop.mock.calls.length, 4);
    const calledTasks = runLoop.mock.calls.map((call) => String(call.arguments[0]));
    assert.deepEqual(calledTasks, ["Big unit", "Sibling", "Child 1", "Child 2"]);
    assert.equal(result.workUnitResults.length, 3);
  });

  it("max depth timeout does not resplit and marks failed result", async () => {
    const deepUnit: WorkUnit = {
      ...createWorkUnit({ goal: "Too deep", scope: "x" }),
      depth: MAX_DECOMPOSITION_DEPTH
    };
    const sibling = createWorkUnit({ goal: "Sibling", scope: "y" });
    const decompose = mock.fn(async () => [deepUnit, sibling]);

    const result = await runDecomposedLoop({
      task: "Main",
      managerAgent: {} as Agent,
      callbacks: createCallbacks(),
      decomposeTaskFn: decompose,
      runPersistenceLoopFn: async (task: string) => {
        if (task === "Too deep") {
          return [createIterationResult({ workProduct: "partial", outcome: "timeout" })];
        }
        return [createIterationResult({ workProduct: `ok:${task}` })];
      },
      synthesizeResultsFn: async (_agent: Agent, _task: string, results: WorkUnitResult[]) => `SYNTH:${results.length}`
    });

    assert.equal(decompose.mock.calls.length, 1);
    assert.equal(result.workUnitResults.length, 2);
    assert.equal(result.workUnitResults[0]?.workUnit.status, "failed");
  });

  it("user interrupt stops processing and returns partial results", async () => {
    const units = [
      createWorkUnit({ goal: "Part A", scope: "A" }),
      createWorkUnit({ goal: "Part B", scope: "B" }),
      createWorkUnit({ goal: "Part C", scope: "C" })
    ];

    const runLoop = mock.fn(async (task: string) => {
      if (task === "Part B") {
        return [createIterationResult({ workProduct: "stop", outcome: "user-interrupted" })];
      }
      return [createIterationResult({ workProduct: `ok:${task}` })];
    });
    const synthesize = mock.fn(async () => "unused");

    const result = await runDecomposedLoop({
      task: "Main",
      managerAgent: {} as Agent,
      callbacks: createCallbacks(),
      decomposeTaskFn: async () => units,
      runPersistenceLoopFn: runLoop,
      synthesizeResultsFn: synthesize
    });

    assert.equal(runLoop.mock.calls.length, 2);
    assert.equal(result.workUnitResults.length, 1);
    assert.equal(synthesize.mock.calls.length, 0);
    assert.equal(result.synthesizedWorkProduct, "ok:Part A");
  });

  it("calls audit logger methods for decomposition, units, and synthesis", async () => {
    const units = [
      createWorkUnit({ goal: "Part A", scope: "A" }),
      createWorkUnit({ goal: "Part B", scope: "B" })
    ];
    const audit = createAuditLoggerMocks();

    await runDecomposedLoop({
      task: "Main",
      managerAgent: {} as Agent,
      callbacks: createCallbacks(),
      decomposeTaskFn: async () => units,
      runPersistenceLoopFn: async (task: string) => [createIterationResult({ workProduct: `ok:${task}`, qualityScore: 88 })],
      synthesizeResultsFn: async () => "synth",
      auditLogger: audit.logger
    });

    assert.equal(audit.logDecomposition.mock.calls.length, 1);
    assert.equal(audit.logWorkUnitStart.mock.calls.length, 2);
    assert.equal(audit.logWorkUnitComplete.mock.calls.length, 2);
    assert.equal(audit.logSynthesis.mock.calls.length, 1);
  });

  it("sends progress notifications for start and completion", async () => {
    const units = [
      createWorkUnit({ goal: "Part A", scope: "A" }),
      createWorkUnit({ goal: "Part B", scope: "B" })
    ];
    const notifications: string[] = [];

    await runDecomposedLoop({
      task: "Main",
      managerAgent: {} as Agent,
      callbacks: createCallbacks(),
      decomposeTaskFn: async () => units,
      runPersistenceLoopFn: async (task: string) => [createIterationResult({ workProduct: `ok:${task}`, qualityScore: 91, totalMs: 456 })],
      synthesizeResultsFn: async () => "synth",
      notify: (message: string) => {
        notifications.push(message);
      }
    });

    assert.equal(notifications.some((n) => n.includes("[1/2]") && n.includes("開始")), true);
    assert.equal(notifications.some((n) => n.includes("[1/2]") && n.includes("完了")), true);
    assert.equal(notifications.some((n) => n.includes("[2/2]") && n.includes("開始")), true);
    assert.equal(notifications.some((n) => n.includes("[2/2]") && n.includes("完了")), true);
  });

  it("formats task-plan metadata with nested indentation for single-unit execution", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-task-plan-"));
    const logsDir = join(tempRoot, "workspace", "logs");
    const taskPlanPath = join(tempRoot, "workspace", "task-plan.md");
    await mkdir(logsDir, { recursive: true });

    try {
      await runDecomposedLoop({
        task: "Main",
        managerAgent: {} as Agent,
        callbacks: createCallbacks(),
        logsDir,
        taskPlanPath,
        decomposeTaskFn: async () => [createWorkUnit({ goal: "Single unit", scope: "Scope" })],
        runPersistenceLoopFn: async () => [createIterationResult({ workProduct: "final product", qualityScore: 91 })],
        synthesizeResultsFn: async () => "final product"
      });

      const content = await readFile(taskPlanPath, "utf-8");
      assert.match(content, /- DONE \[L1-001\] Single unit/);
      assert.match(content, /  - 品質スコア: 91\/100/);
      assert.match(content, /  - findingsFile: output\/wu-/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("multiple sequential query-manager interrupts during decompose do not stop the loop", async () => {
    const units = [
      createWorkUnit({ goal: "Unit A", scope: "A" }),
      createWorkUnit({ goal: "Unit B", scope: "B" })
    ];
    const queryQuestions: string[] = [];
    let interruptCallIdx = 0;

    // Produces: query-manager x2, then never fires (decompose finishes first)
    const waitForInterrupt = () => new Promise<import("./persistence-loop.js").InterruptRequest>((resolve) => {
      interruptCallIdx += 1;
      if (interruptCallIdx <= 2) {
        resolve({ type: "query-manager", question: `Q${interruptCallIdx}` });
      }
      // else: never resolves → decompose wins
    });

    const result = await runDecomposedLoop({
      task: "Main",
      managerAgent: {} as Agent,
      callbacks: {
        ...createCallbacks(),
        onQueryManager: async (q) => { queryQuestions.push(q); return "answer"; }
      },
      // Delay long enough for 2 synchronous query-manager interrupts to be handled first
      decomposeTaskFn: async () => { await new Promise<void>((r) => setTimeout(r, 50)); return units; },
      runPersistenceLoopFn: async (task: string) => [createIterationResult({ workProduct: `ok:${task}` })],
      synthesizeResultsFn: async () => "done",
      waitForInterrupt
    });

    assert.equal(queryQuestions.length, 2);
    assert.deepEqual(queryQuestions, ["Q1", "Q2"]);
    assert.equal(result.wasInterrupted, undefined);
    assert.equal(result.workUnitResults.length, 2);
  });

  it("stop after query-manager during decompose aborts the task and returns wasInterrupted", async () => {
    let interruptCallIdx = 0;
    let aborted = false;

    const waitForInterrupt = () => new Promise<import("./persistence-loop.js").InterruptRequest>((resolve) => {
      interruptCallIdx += 1;
      // First call: query-manager; second: stop
      resolve(interruptCallIdx === 1
        ? { type: "query-manager", question: "What's happening?" }
        : { type: "stop" }
      );
    });

    const result = await runDecomposedLoop({
      task: "Main",
      managerAgent: {} as Agent,
      callbacks: {
        ...createCallbacks(),
        onQueryManager: async () => "manager answer"
      },
      decomposeTaskFn: async (_, __, opts) => {
        // Long decompose so interrupt wins
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, 500);
          opts?.signal?.addEventListener("abort", () => { clearTimeout(t); aborted = true; reject(new DOMException("Aborted", "AbortError")); });
        });
        return [createWorkUnit({ goal: "A", scope: "A" })];
      },
      runPersistenceLoopFn: async () => [],
      synthesizeResultsFn: async () => "unused",
      waitForInterrupt
    });

    assert.equal(aborted, true);
    assert.equal(result.wasInterrupted, true);
    assert.equal(result.workUnitResults.length, 0);
  });
});

