import assert from "node:assert/strict";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it, mock } from "node:test";

import type { Agent, AgentToolResult } from "@mariozechner/pi-agent-core";

import type { AgentRegistry } from "../communication/agent-registry.js";
import { parseEvaluationReport, type EvaluationReport } from "./evaluation-report.js";
import { type ImprovementRequest, formatImprovementRequest } from "./improvement-request.js";
import type { IterationResult, WorkerContext } from "./persistence-loop.js";
import { createLoopCallbacks, loopIntegrationDependencies, type UserInteraction } from "./loop-integration.js";

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

afterEach(() => {
  mock.restoreAll();
});

describe("createLoopCallbacks", () => {
  it("executeWorker falls back to output/report.md when agent text response is empty", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const sandboxDir = join(tmpdir(), `pi-agent-test-${Date.now()}`);
    const outputDir = join(sandboxDir, "output");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "report.md"), "## Report from file\nFile content here.", "utf8");

    mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult(""));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      workerSandboxDir: sandboxDir,
      ui: createMockUI()
    });

    const result = await callbacks.executeWorker("task", { iteration: 1 });

    assert.equal(result, "## Report from file\nFile content here.");

    await rm(sandboxDir, { recursive: true, force: true });
  });

  it("executeWorker prefers agent text response over output/report.md when both exist", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    const sandboxDir = join(tmpdir(), `pi-agent-test-${Date.now()}`);
    const outputDir = join(sandboxDir, "output");
    await mkdir(outputDir, { recursive: true });
    await writeFile(join(outputDir, "report.md"), "File content", "utf8");

    mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult("Agent text response"));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      workerSandboxDir: sandboxDir,
      ui: createMockUI()
    });

    const result = await callbacks.executeWorker("task", { iteration: 1 });

    assert.equal(result, "Agent text response");

    await rm(sandboxDir, { recursive: true, force: true });
  });

  it("executeWorker returns empty string when agent response is empty and no output file exists", async () => {
    const worker = createMockAgent();
    const manager = createMockAgent();
    const { registry } = createRegistry(worker.agent, manager.agent);

    mock.method(loopIntegrationDependencies, "invokeAgent", async () => createInvokeResult(""));

    const callbacks = createLoopCallbacks({
      registry,
      workerConfigDir: "/tmp/worker",
      workerSandboxDir: join(tmpdir(), "pi-agent-nonexistent-sandbox"),
      ui: createMockUI()
    });

    const result = await callbacks.executeWorker("task", { iteration: 1 });

    assert.equal(result, "");
  });

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
});
