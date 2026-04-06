import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";

import type { Agent, AgentToolResult } from "@mariozechner/pi-agent-core";

import type { AgentRegistry } from "../communication/agent-registry.js";
import { loopIntegrationDependencies } from "../loop/loop-integration.js";
import { createCustomToolDefinitions } from "./tool-definitions.js";
import { createHumanToolStatusController } from "./human-tool-status-ref.js";

function createMockAgent(): Agent {
  return {
    prompt: mock.fn(async () => {}),
    waitForIdle: mock.fn(async () => {}),
    state: {
      messages: [],
      systemPrompt: "",
      tools: []
    },
    subscribe: mock.fn(() => () => {}),
    reset: mock.fn(() => {}),
    setTools: mock.fn(() => {})
  } as unknown as Agent;
}

function createRegistry(worker: Agent, manager: Agent): AgentRegistry {
  return {
    get: mock.fn(async (name: string) => {
      if (name === "worker") {
        return worker;
      }
      if (name === "manager") {
        return manager;
      }
      throw new Error(`Unknown agent: ${name}`);
    }),
    evict: mock.fn(() => {})
  } as unknown as AgentRegistry;
}

function createInvokeResult(text: string, isError?: boolean): AgentToolResult<void> {
  return {
    content: [{ type: "text", text }],
    details: undefined,
    ...(isError ? { isError: true } : {})
  } as AgentToolResult<void>;
}

afterEach(() => {
  mock.restoreAll();
});

async function waitForCondition(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start >= timeoutMs) {
      throw new Error("Timed out waiting for expected test condition");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

describe("start_research_loop Ctrl+X path", () => {
  it("routes Ask manager through query-manager so task-plan context is attached", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "start-research-loop-"));
    const workerConfigDir = join(tempRoot, "agents", "worker");
    const sandboxDir = join(tempRoot, "workspace");
    const taskPlanPath = join(sandboxDir, "task-plan.md");
    await mkdir(workerConfigDir, { recursive: true });
    await mkdir(join(sandboxDir, "output"), { recursive: true });

    const workerAgent = createMockAgent();
    const managerAgent = createMockAgent();
    const registry = createRegistry(workerAgent, managerAgent);

    const terminalCallbacks: Array<(data: string) => { consume?: boolean } | undefined> = [];
    const notifications: string[] = [];
    let resolveWorkerInitial: (() => void) | undefined;
    let queryManagerPrompt = "";

    const ui = {
      select: mock.fn(async () => "Ask manager a question"),
      input: mock.fn(async (title: string) => (title.includes("Question for the Manager") ? "現在の進捗を教えて" : "")),
      notify: mock.fn((message: string) => {
        notifications.push(message);
      }),
      setStatus: mock.fn((message: string) => {
      }),
      setWorkingMessage: mock.fn(() => {}),
      onTerminalInput(callback: (data: string) => { consume?: boolean } | undefined) {
        terminalCallbacks.push(callback);
        return () => {};
      }
    };

    const invokeMock = mock.method(loopIntegrationDependencies, "invokeAgent", async (agent: Agent, message: string) => {
      const callIndex = invokeMock.mock.calls.length;
      if (callIndex === 1) {
        return createInvokeResult("[{\"goal\":\"Single unit\",\"scope\":\"Scope\",\"outOfScope\":\"\"}]");
      }
      if (callIndex === 2) {
        return new Promise<AgentToolResult<void>>((resolve) => {
          resolveWorkerInitial = () => {
            resolve(createInvokeResult("W".repeat(240)));
          };
        });
      }
      if (callIndex === 3) {
        queryManagerPrompt = message;
        return createInvokeResult("Manager answer");
      }
      if (callIndex === 4) {
        return createInvokeResult("W".repeat(240));
      }
      if (callIndex === 5) {
        return createInvokeResult([
          "## Quality Score",
          "90",
          "",
          "## Summary",
          "Looks good.",
          "",
          "## Issues"
        ].join("\n"));
      }
      return createInvokeResult("fallback");
    });

    const tools = createCustomToolDefinitions({
      registry,
      workerConfigDir,
      sandboxDir,
      taskPlanPath,
      humanToolRuntimeController: createHumanToolStatusController()
    });
    const startResearchLoop = tools.find((tool) => tool.name === "start_research_loop");
    assert.ok(startResearchLoop);

    const execution = startResearchLoop!.execute(
      "tool-call-1",
      { task: "Investigate status updates", maxIterations: 1, qualityThreshold: 0 },
      undefined,
      undefined,
      { hasUI: true, ui } as unknown as Parameters<typeof startResearchLoop.execute>[4]
    );

    const terminalCallback = terminalCallbacks[0];
    assert.ok(terminalCallback);
    terminalCallback?.("\x18");

    await waitForCondition(() => queryManagerPrompt.length > 0);
    assert.equal(queryManagerPrompt.includes("[現在のタスク計画]"), true);
    assert.equal(queryManagerPrompt.includes("Investigate status updates"), true);

    resolveWorkerInitial?.();

    const result = await execution;

    assert.equal(result.content[0]?.type, "text");
    assert.equal(notifications.some((message) => message.includes("Manager answer")), true);
    assert.equal(ui.select.mock.calls.length, 1);
    assert.equal(ui.input.mock.calls.length, 1);
    await rm(tempRoot, { recursive: true, force: true });
  });
});
