import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type { Agent, AgentToolResult } from "@mariozechner/pi-agent-core";

import type { AgentRegistry } from "../communication/agent-registry.js";
import { parseEvaluationReport, type EvaluationReport } from "./evaluation-report.js";
import { type ImprovementRequest, formatImprovementRequest } from "./improvement-request.js";
import type { IterationResult, WorkerContext } from "./persistence-loop.js";
import { createLoopCallbacks, loopIntegrationDependencies, type UserInteraction, type LoopStatusReporter } from "./loop-integration.js";

function createMockAgent(): { agent: Agent; reset: ReturnType<typeof mock.fn> } {
  const reset = mock.fn(() => {});
  const agent = {
    prompt: mock.fn(async () => {}),
    waitForIdle: mock.fn(async () => {}),
    state: {
      messages: [],
      systemPrompt: "",
      tools: []
    },
    subscribe: mock.fn(() => () => {}),
    reset,
    setTools: mock.fn(() => {})
  };

  return {
    agent: agent as unknown as Agent,
    reset
  };
}

function createRegistry(worker: Agent, manager: Agent): {
  registry: AgentRegistry;
  get: ReturnType<typeof mock.fn>;
  evict: ReturnType<typeof mock.fn>;
} {
  const get = mock.fn(async (name: string) => {
    if (name === "worker") {
      return worker;
    }

    if (name === "manager") {
      return manager;
    }

    throw new Error(`Unknown agent: ${name}`);
  });
  const evict = mock.fn(() => {});

  return {
    registry: { get, evict } as unknown as AgentRegistry,
    get,
    evict
  };
}

function createInvokeResult(text: string, isError?: boolean): AgentToolResult<void> {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    ...(isError ? { isError: true } : {})
  } as AgentToolResult<void>;
}

function createEvaluation(): EvaluationReport {
  return {
    qualityScore: 81,
    summary: "Generic summary text.",
    issues: []
  };
}

function createMockUI(overrides?: Partial<UserInteraction>): UserInteraction {
  return {
    select: overrides?.select ?? (async () => undefined),
    input: overrides?.input ?? (async () => undefined),
    notify: overrides?.notify ?? (() => {})
  };
}

function createMockStatusReporter(): LoopStatusReporter & {
  onWorkerStart: ReturnType<typeof mock.fn>;
  onEvaluationStart: ReturnType<typeof mock.fn>;
  onFeedbackWaiting: ReturnType<typeof mock.fn>;
  onImprovementStart: ReturnType<typeof mock.fn>;
  onLoopComplete: ReturnType<typeof mock.fn>;
  onLoopInterrupted: ReturnType<typeof mock.fn>;
} {
  return {
    onWorkerStart: mock.fn(() => {}),
    onEvaluationStart: mock.fn(() => {}),
    onFeedbackWaiting: mock.fn(() => {}),
    onImprovementStart: mock.fn(() => {}),
    onLoopComplete: mock.fn(() => {}),
    onLoopInterrupted: mock.fn(() => {})
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe("createLoopCallbacks", () => {
  it("executeWorker calls invokeAgent with worker agent and extracts text", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const invokeMock = mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult("worker response"));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI()
    });

    const result = await callbacks.executeWorker("placeholder task", { iteration: 1 });

    assert.equal(result, "worker response");
    assert.equal(worker.reset.mock.calls.length, 1);
    assert.equal(invokeMock.mock.calls.length, 1);
    assert.equal(invokeMock.mock.calls[0]?.arguments[0], worker.agent);
    assert.equal(invokeMock.mock.calls[0]?.arguments[1], "placeholder task");
  });

  it("executeWorker augments prompt on iteration 2+ with previous evaluation context", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const invokeMock = mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult("improved response"));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI()
    });

    const context: WorkerContext = {
      iteration: 2,
      previousEvaluation: {
        qualityScore: 60,
        summary: "Needs more sources",
        issues: [{ category: "citations", description: "Missing URLs", evidence: "No links", cause: "config" }]
      },
      previousFeedback: "Add more references"
    };

    const result = await callbacks.executeWorker("research MDM tools", context);

    assert.equal(result, "improved response");
    const prompt = String(invokeMock.mock.calls[0]?.arguments[1] ?? "");
    assert.equal(prompt.includes("research MDM tools"), true);
    assert.equal(prompt.includes("イテレーション2"), true);
    assert.equal(prompt.includes("60/100"), true);
    assert.equal(prompt.includes("Missing URLs"), true);
    assert.equal(prompt.includes("Add more references"), true);
  });

  it("evaluateProduct invokes manager with evaluation prompt and parses response", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const response = [
      "## Quality Score",
      "90",
      "",
      "## Summary",
      "Generic summary for evaluation.",
      "",
      "## Issues",
      "Category: coverage",
      "Description: Missing detail",
      "Evidence: The text omits one part.",
      "Cause: config"
    ].join("\n");
    const invokeMock = mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult(response));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI()
    });

    const report = await callbacks.evaluateProduct("placeholder work product");

    assert.deepEqual(report, parseEvaluationReport(response));
    assert.equal(invokeMock.mock.calls.length, 1);
    assert.equal(invokeMock.mock.calls[0]?.arguments[0], manager.agent);
    const prompt = String(invokeMock.mock.calls[0]?.arguments[1] ?? "");
    assert.equal(prompt.includes("Respond ONLY with a structured evaluation report"), true);
    assert.equal(prompt.includes("Work Product:\nplaceholder work product"), true);
  });

  it("getUserFeedback returns approved when user selects approve", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const ui = createMockUI({
      select: async () => "approve"
    });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui
    });

    const feedback = await callbacks.getUserFeedback("placeholder work product", createEvaluation(), 1);

    assert.deepEqual(feedback, { type: "approved" });
  });

  it("getUserFeedback returns improve with feedback when user selects improve", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const ui = createMockUI({
      select: async () => "improve",
      input: async () => "Please improve the draft."
    });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui
    });

    const feedback = await callbacks.getUserFeedback("placeholder work product", createEvaluation(), 2);

    assert.deepEqual(feedback, { type: "improve", feedback: "Please improve the draft." });
  });

  it("getUserFeedback returns interrupt when user selects quit", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const ui = createMockUI({
      select: async () => "quit"
    });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui
    });

    const feedback = await callbacks.getUserFeedback("placeholder work product", createEvaluation(), 3);

    assert.deepEqual(feedback, { type: "interrupt" });
  });

  it("getUserFeedback returns interrupt when user cancels selection", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const ui = createMockUI({
      select: async () => undefined
    });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui
    });

    const feedback = await callbacks.getUserFeedback("placeholder work product", createEvaluation(), 1);

    assert.deepEqual(feedback, { type: "interrupt" });
  });

  it("executeImprovement formats requests, invokes manager, and evicts worker", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry, evict } = createRegistry(worker.agent, manager.agent);

    const requests: ImprovementRequest[] = [
      {
        issueCategory: "structure",
        issueEvidence: "Generic evidence",
        workProductExcerpt: "Generic excerpt",
        relatedConfigSection: "Generic config section",
        improvementDirection: "Generic direction",
        userFeedback: "Generic user feedback"
      }
    ];

    const invokeMock = mock.method(
      loopIntegrationDependencies,
      "invokeAgent",
      async () => createInvokeResult("Applied one\nApplied two")
    );

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI()
    });

    const result = await callbacks.executeImprovement(requests);

    assert.deepEqual(result, ["Applied one", "Applied two"]);
    assert.equal(invokeMock.mock.calls.length, 1);
    assert.equal(invokeMock.mock.calls[0]?.arguments[0], manager.agent);
    const prompt = String(invokeMock.mock.calls[0]?.arguments[1] ?? "");
    assert.equal(prompt.includes(formatImprovementRequest(requests[0]!)), true);
    assert.equal(evict.mock.calls.length, 1);
    assert.equal(evict.mock.calls[0]?.arguments[0], "worker");
  });

  it("executeImprovement sends user feedback as first manager message when pendingUserFeedback is set", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const invokeMock = mock.method(
      loopIntegrationDependencies,
      "invokeAgent",
      async () => createInvokeResult("Applied")
    );

    const ui = createMockUI({
      select: async () => "improve",
      input: async () => "Please add more citations."
    });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui
    });

    await callbacks.getUserFeedback("work product", createEvaluation(), 1);
    await callbacks.executeImprovement([
      {
        issueCategory: "citations",
        issueEvidence: "no links",
        workProductExcerpt: "excerpt",
        relatedConfigSection: "section",
        improvementDirection: "direction",
        userFeedback: "Please add more citations."
      }
    ]);

    assert.equal(invokeMock.mock.calls.length, 2);
    const feedbackCall = invokeMock.mock.calls[0]?.arguments[1];
    assert.equal(String(feedbackCall).includes("Please add more citations."), true);
    const improvementCall = invokeMock.mock.calls[1]?.arguments[1];
    assert.equal(String(improvementCall).includes("Apply the following improvement requests"), true);
  });

  it("executeImprovement does not send extra feedback message when no pending feedback", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const invokeMock = mock.method(
      loopIntegrationDependencies,
      "invokeAgent",
      async () => createInvokeResult("Applied")
    );

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI()
    });

    await callbacks.executeImprovement([
      {
        issueCategory: "structure",
        issueEvidence: "evidence",
        workProductExcerpt: "excerpt",
        relatedConfigSection: "section",
        improvementDirection: "direction",
        userFeedback: ""
      }
    ]);

    assert.equal(invokeMock.mock.calls.length, 1);
    const prompt = String(invokeMock.mock.calls[0]?.arguments[1] ?? "");
    assert.equal(prompt.includes("Apply the following improvement requests"), true);
  });

  it("pending feedback is cleared after executeImprovement so subsequent calls do not re-inject it", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const invokeMock = mock.method(
      loopIntegrationDependencies,
      "invokeAgent",
      async () => createInvokeResult("Applied")
    );

    const ui = createMockUI({
      select: async () => "improve",
      input: async () => "First feedback"
    });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui
    });

    const request: ImprovementRequest = {
      issueCategory: "coverage",
      issueEvidence: "evidence",
      workProductExcerpt: "excerpt",
      relatedConfigSection: "section",
      improvementDirection: "direction",
      userFeedback: "First feedback"
    };

    await callbacks.getUserFeedback("work", createEvaluation(), 1);
    await callbacks.executeImprovement([request]);
    const callsAfterFirst = invokeMock.mock.calls.length;

    await callbacks.executeImprovement([request]);
    const callsAfterSecond = invokeMock.mock.calls.length;

    assert.equal(callsAfterFirst, 2);
    assert.equal(callsAfterSecond - callsAfterFirst, 1);
  });

  it("readCurrentConfig delegates to loadAgentConfig", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const loadMock = mock.method(loopIntegrationDependencies, "loadAgentConfig", async () => "generic-config");
    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/generic-worker",
      ui: createMockUI()
    });

    const config = await callbacks.readCurrentConfig();

    assert.equal(config, "generic-config");
    assert.equal(loadMock.mock.calls.length, 1);
    assert.equal(loadMock.mock.calls[0]?.arguments[0], "/tmp/generic-worker");
  });

  it("onIterationComplete calls report callback", () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);
    const reports: string[] = [];

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      onIterationReport: (report) => {
        reports.push(report);
      }
    });

    const iterationResult: IterationResult = {
      iteration: 4,
      workProduct: "placeholder work",
      evaluation: createEvaluation(),
      improvements: ["generic improvement"],
      latencyMs: {
        workerExecutionMs: 10,
        evaluationMs: 20,
        managerImprovementMs: 30,
        totalMs: 60
      },
      outcome: "improvement-applied"
    };

    callbacks.onIterationComplete(iterationResult);

    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.includes("Iteration 4"), true);
    assert.equal(reports[0]?.includes("improvement-applied"), true);
    assert.equal(reports[0]?.includes("81/100"), true);
    assert.equal(reports[0]?.includes("60ms"), true);
  });

  it("passes through waitForInterrupt when provided", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);
    const waitForInterrupt = mock.fn(async () => ({ type: "stop" as const }));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      waitForInterrupt
    });

    assert.equal(callbacks.waitForInterrupt, waitForInterrupt);
    const interrupt = await callbacks.waitForInterrupt?.();
    assert.deepEqual(interrupt, { type: "stop" });
  });

  it("leaves waitForInterrupt undefined when not provided", () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI()
    });

    assert.equal(callbacks.waitForInterrupt, undefined);
  });
});

describe("autonomous mode (qualityThreshold)", () => {
  it("auto-approves when qualityScore meets threshold", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const selectFn = mock.fn(async () => "should-not-be-called");
    const ui = createMockUI({ select: selectFn });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui,
      qualityThreshold: 70
    });

    const evaluation = { qualityScore: 85, summary: "Good.", issues: [] };
    const feedback = await callbacks.getUserFeedback("work", evaluation, 1);

    assert.deepEqual(feedback, { type: "approved" });
    assert.equal(selectFn.mock.calls.length, 0);
  });

  it("auto-improves with issue descriptions when score is below threshold", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const selectFn = mock.fn(async () => "should-not-be-called");
    const ui = createMockUI({ select: selectFn });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui,
      qualityThreshold: 80
    });

    const evaluation = {
      qualityScore: 55,
      summary: "Needs work.",
      issues: [
        { category: "coverage" as const, description: "Missing auth section", evidence: "none", cause: "config" as const },
        { category: "accuracy" as const, description: "Outdated data", evidence: "v1 ref", cause: "task-difficulty" as const }
      ]
    };
    const feedback = await callbacks.getUserFeedback("work", evaluation, 1);

    assert.equal(feedback.type, "improve");
    if (feedback.type === "improve") {
      assert.equal(feedback.feedback.includes("Missing auth section"), true);
      assert.equal(feedback.feedback.includes("Outdated data"), true);
    }
    assert.equal(selectFn.mock.calls.length, 0);
  });

  it("auto-improves with generic message when below threshold and no issues", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      qualityThreshold: 90
    });

    const evaluation = { qualityScore: 50, summary: "Below bar.", issues: [] };
    const feedback = await callbacks.getUserFeedback("work", evaluation, 2);

    assert.equal(feedback.type, "improve");
    if (feedback.type === "improve") {
      assert.equal(feedback.feedback.includes("50"), true);
      assert.equal(feedback.feedback.includes("90"), true);
    }
  });

  it("auto-approves at exact threshold boundary", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      qualityThreshold: 75
    });

    const evaluation = { qualityScore: 75, summary: "Meets threshold.", issues: [] };
    const feedback = await callbacks.getUserFeedback("work", evaluation, 1);

    assert.deepEqual(feedback, { type: "approved" });
  });

  it("falls back to UI interaction when qualityThreshold is not set", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const selectFn = mock.fn(async () => "approve");
    const ui = createMockUI({ select: selectFn });

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui
    });

    const evaluation = { qualityScore: 95, summary: "Excellent.", issues: [] };
    const feedback = await callbacks.getUserFeedback("work", evaluation, 1);

    assert.deepEqual(feedback, { type: "approved" });
    assert.equal(selectFn.mock.calls.length, 1);
  });
});

describe("LoopStatusReporter integration", () => {
  it("calls onWorkerStart with iteration and maxIterations when executeWorker is called", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);
    const statusReporter = createMockStatusReporter();

    mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult("worker response"));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      statusReporter,
      maxIterations: 5
    });

    await callbacks.executeWorker("task", { iteration: 2 });

    assert.deepEqual(statusReporter.onWorkerStart.mock.calls[0]?.arguments, [2, 5]);
    assert.equal(statusReporter.onEvaluationStart.mock.calls.length, 0);
  });

  it("calls onEvaluationStart with currentIteration when evaluateProduct is called", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);
    const statusReporter = createMockStatusReporter();

    const response = [
      "## Quality Score",
      "90",
      "",
      "## Summary",
      "Generic summary for evaluation.",
      "",
      "## Issues",
      "Category: coverage",
      "Description: Missing detail",
      "Evidence: The text omits one part.",
      "Cause: config"
    ].join("\n");
    mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult(response));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      statusReporter,
      maxIterations: 7
    });

    await callbacks.evaluateProduct("product");

    assert.deepEqual(statusReporter.onEvaluationStart.mock.calls[0]?.arguments, [1, 7]);
  });

  it("calls onFeedbackWaiting with score before ui.select in interactive mode", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);
    const statusReporter = createMockStatusReporter();

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI({ select: async () => "approve" }),
      statusReporter
    });

    await callbacks.getUserFeedback("product", { qualityScore: 72, summary: "ok", issues: [] }, 3);

    assert.deepEqual(statusReporter.onFeedbackWaiting.mock.calls[0]?.arguments, [3, 10, 72]);
  });

  it("does NOT call onFeedbackWaiting in autonomous mode", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);
    const statusReporter = createMockStatusReporter();

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI({ select: async () => "approve" }),
      qualityThreshold: 80,
      statusReporter
    });

    await callbacks.getUserFeedback("product", { qualityScore: 50, summary: "needs work", issues: [] }, 3);

    assert.equal(statusReporter.onFeedbackWaiting.mock.calls.length, 0);
  });

  it("calls onImprovementStart when executeImprovement is called", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);
    const statusReporter = createMockStatusReporter();

    mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult("Applied one"));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      statusReporter
    });

    await callbacks.executeImprovement([
      {
        issueCategory: "structure",
        issueEvidence: "evidence",
        workProductExcerpt: "excerpt",
        relatedConfigSection: "section",
        improvementDirection: "direction",
        userFeedback: ""
      }
    ]);

    assert.deepEqual(statusReporter.onImprovementStart.mock.calls[0]?.arguments, [1, 10]);
  });

  it("calls onLoopComplete on terminal outcomes and onLoopInterrupted on interrupted", () => {
    const workerA = createMockAgent();
    const managerA = createMockAgent();
    const { registry: registryA } = createRegistry(workerA.agent, managerA.agent);
    const statusReporterA = createMockStatusReporter();

    const callbacksA = createLoopCallbacks({
      registry: registryA,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      statusReporter: statusReporterA
    });

    callbacksA.onIterationComplete({
      iteration: 2,
      workProduct: "work",
      evaluation: { qualityScore: 90, summary: "good", issues: [] },
      improvements: [],
      latencyMs: {
        workerExecutionMs: 1,
        evaluationMs: 1,
        managerImprovementMs: 1,
        totalMs: 3
      },
      outcome: "user-approved"
    });

    assert.deepEqual(statusReporterA.onLoopComplete.mock.calls[0]?.arguments, [2, 90]);
    assert.equal(statusReporterA.onLoopInterrupted.mock.calls.length, 0);

    const workerB = createMockAgent();
    const managerB = createMockAgent();
    const { registry: registryB } = createRegistry(workerB.agent, managerB.agent);
    const statusReporterB = createMockStatusReporter();

    const callbacksB = createLoopCallbacks({
      registry: registryB,
      workerConfigDir: "/tmp/worker",
      ui: createMockUI(),
      statusReporter: statusReporterB
    });

    callbacksB.onIterationComplete({
      iteration: 1,
      workProduct: "work",
      evaluation: { qualityScore: 30, summary: "bad", issues: [] },
      improvements: [],
      latencyMs: {
        workerExecutionMs: 1,
        evaluationMs: 1,
        managerImprovementMs: 1,
        totalMs: 3
      },
      outcome: "user-interrupted"
    });

    assert.deepEqual(statusReporterB.onLoopInterrupted.mock.calls[0]?.arguments, [1]);
  });
});
