import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Agent, type AgentEvent, type AgentMessage, type AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { getModel, streamSimple } from "@mariozechner/pi-ai";

import { createManagerAgent } from "../agents/manager-agent.js";
import { createWorkerAgent } from "../agents/worker-agent.js";
import { AgentRegistry } from "../communication/agent-registry.js";
import { loadAgentConfig } from "../config/config-loader.js";
import { createCustomToolDefinitions } from "../tools/tool-definitions.js";

const API_KEY = process.env["ANTHROPIC_API_KEY"];
const SKIP_REASON = "ANTHROPIC_API_KEY not set — skipping E2E tests";
const TEST_TIMEOUT_MS = 120_000;

const testModel = getModel("anthropic", "claude-sonnet-4-20250514");
const getApiKey = (provider: string): string | undefined => process.env[`${provider.toUpperCase()}_API_KEY`];

const AskUserSchema = Type.Object({ question: Type.String() });

function createStubAskUserTool(): AgentTool<any> {
  return {
    name: "ask_user",
    label: "Ask User",
    description: "Asks the user for clarification and returns their response.",
    parameters: AskUserSchema,
    async execute() {
      return {
        content: [{ type: "text", text: "Please treat this as a work request and provide a short answer." }],
        details: undefined
      };
    }
  };
}

function extractAssistantText(messages: AgentMessage[]): string {
  return messages
    .filter((message): message is AgentMessage & { role: "assistant"; content: Array<{ type: string; text?: string }> } => message.role === "assistant")
    .flatMap((message) => message.content)
    .filter((content): content is { type: "text"; text: string } => content.type === "text" && typeof content.text === "string")
    .map((content) => content.text)
    .join("\n")
    .trim();
}

async function writeAgentConfig(dir: string, files: { agent: string; system: string; appendSystem: string }): Promise<void> {
  await mkdir(join(dir, "skills"), { recursive: true });
  await mkdir(join(dir, "backups"), { recursive: true });
  await writeFile(join(dir, "agent.md"), files.agent, "utf-8");
  await writeFile(join(dir, "system.md"), files.system, "utf-8");
  await writeFile(join(dir, "APPEND_SYSTEM.md"), files.appendSystem, "utf-8");
}

async function createRegistry(options: {
  workerConfigDir: string;
  managerConfigDir: string;
  sandboxDir: string;
}): Promise<AgentRegistry> {
  const registry = new AgentRegistry();

  registry.register("worker", async () => {
    return createWorkerAgent({
      configDir: options.workerConfigDir,
      sandboxDir: options.sandboxDir,
      model: testModel,
      streamFn: streamSimple,
      getApiKey
    });
  });

  registry.register("manager", async () => {
    return createManagerAgent({
      configDir: options.managerConfigDir,
      workerConfigDir: options.workerConfigDir,
      sandboxDir: options.sandboxDir,
      taskPlanPath: join(options.sandboxDir, "task-plan.md"),
      model: testModel,
      streamFn: streamSimple,
      getApiKey
    });
  });

  return registry;
}

async function createProxyForTest(configDir: string, registry: AgentRegistry, workerConfigDir: string, sandboxDir: string): Promise<Agent> {
  const systemPrompt = await loadAgentConfig(configDir);
  const agent = new Agent({
    initialState: { systemPrompt, model: testModel },
    streamFn: streamSimple,
    getApiKey
  });
  const customTools = createCustomToolDefinitions({ registry, workerConfigDir, sandboxDir, taskPlanPath: join(sandboxDir, "task-plan.md") });
  agent.setTools(customTools as any);
  return agent;
}

describe("E2E integration tests", { skip: !API_KEY ? SKIP_REASON : undefined }, () => {
  const tempRoots = new Set<string>();

  before(() => {
    tempRoots.clear();
  });

  after(async () => {
    for (const root of tempRoots) {
      await rm(root, { recursive: true, force: true });
    }
    tempRoots.clear();
  });

  it("8.1 work request routes through start_research_loop and returns output", { timeout: TEST_TIMEOUT_MS }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-e2e-work-"));
    tempRoots.add(tempRoot);

    const workerConfigDir = join(tempRoot, "agents", "worker");
    const managerConfigDir = join(tempRoot, "agents", "manager");
    const proxyConfigDir = join(tempRoot, "agents", "proxy");
    const sandboxDir = join(tempRoot, "workspace");

    await mkdir(sandboxDir, { recursive: true });
    await mkdir(join(sandboxDir, "output"), { recursive: true });

    await writeAgentConfig(workerConfigDir, {
      agent: "You are a worker agent.",
      system: "Respond directly to the request in plain text. Do not ask follow-up questions.",
      appendSystem: "Prefer concise but useful responses."
    });
    await writeAgentConfig(managerConfigDir, {
      agent: "You are a manager agent.",
      system: "Evaluate the work product and provide a quality score. Use evaluate_work_product when available.",
      appendSystem: ""
    });
    await writeAgentConfig(proxyConfigDir, {
      agent: "You are a proxy router.",
      system: "For all user requests, call start_research_loop with the user's message as the task. For simple questions, use qualityThreshold=0 and maxIterations=1.",
      appendSystem: "If ambiguous, call ask_user."
    });

    const registry = await createRegistry({ workerConfigDir, managerConfigDir, sandboxDir });
    const proxy = await createProxyForTest(proxyConfigDir, registry, workerConfigDir, sandboxDir);

    const toolStarts: string[] = [];
    const unsubscribe = proxy.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_start") {
        toolStarts.push(event.toolName);
      }
    });

    let proxyText = "";
    try {
      await proxy.prompt("Write a brief report about common programming paradigms.");
      await proxy.waitForIdle();
      proxyText = extractAssistantText(proxy.state.messages);
    } finally {
      unsubscribe();
      registry.shutdownAll();
      await rm(tempRoot, { recursive: true, force: true });
      tempRoots.delete(tempRoot);
    }

    assert.equal(toolStarts.includes("start_research_loop"), true, "Expected start_research_loop to be called");
    assert.equal(proxyText.length > 0, true, "Expected non-empty output from proxy");
  });

  it("8.2 improvement request routes through start_research_loop", { timeout: TEST_TIMEOUT_MS }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-e2e-improve-"));
    tempRoots.add(tempRoot);

    const workerConfigDir = join(tempRoot, "agents", "worker");
    const managerConfigDir = join(tempRoot, "agents", "manager");
    const proxyConfigDir = join(tempRoot, "agents", "proxy");
    const sandboxDir = join(tempRoot, "workspace");

    await mkdir(sandboxDir, { recursive: true });
    await mkdir(join(sandboxDir, "output"), { recursive: true });

    await writeAgentConfig(workerConfigDir, {
      agent: "You are a worker agent.",
      system: "Create reports from user requests.",
      appendSystem: "Keep responses short."
    });
    await writeAgentConfig(managerConfigDir, {
      agent: "You are a manager agent.",
      system: "For improvement requests, inspect worker config and call update_worker_config with a focused improvement.",
      appendSystem: "Always leave APPEND_SYSTEM.md non-empty after updates."
    });
    await writeAgentConfig(proxyConfigDir, {
      agent: "You are a proxy router.",
      system: "For all user requests, call start_research_loop. For improvement requests about worker quality, set qualityThreshold=70 and maxIterations=5.",
      appendSystem: "If ambiguous, call ask_user."
    });

    const registry = await createRegistry({ workerConfigDir, managerConfigDir, sandboxDir });
    const proxy = await createProxyForTest(proxyConfigDir, registry, workerConfigDir, sandboxDir);

    const toolStarts: string[] = [];
    const unsubscribe = proxy.subscribe((event: AgentEvent) => {
      if (event.type === "tool_execution_start") {
        toolStarts.push(event.toolName);
      }
    });

    let proxyText = "";
    try {
      await proxy.prompt("The worker's reports lack structure. Please improve the quality of reports produced.");
      await proxy.waitForIdle();
      proxyText = extractAssistantText(proxy.state.messages);
    } finally {
      unsubscribe();
      registry.shutdownAll();
      await rm(tempRoot, { recursive: true, force: true });
      tempRoots.delete(tempRoot);
    }

    assert.equal(toolStarts.includes("start_research_loop"), true, "Expected start_research_loop to be called for improvement request");
    assert.equal(proxyText.length > 0, true, "Expected non-empty output from proxy");
  });

  it("8.3 ambiguous request completes with stub ask_user tool (no stdin hang)", { timeout: TEST_TIMEOUT_MS }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-e2e-ambiguous-"));
    tempRoots.add(tempRoot);

    const workerConfigDir = join(tempRoot, "agents", "worker");
    const managerConfigDir = join(tempRoot, "agents", "manager");
    const proxyConfigDir = join(tempRoot, "agents", "proxy");
    const sandboxDir = join(tempRoot, "workspace");

    await mkdir(sandboxDir, { recursive: true });
    await writeAgentConfig(workerConfigDir, {
      agent: "You are a worker agent.",
      system: "Answer tasks directly.",
      appendSystem: ""
    });
    await writeAgentConfig(managerConfigDir, {
      agent: "You are a manager agent.",
      system: "Improve worker settings when requested.",
      appendSystem: ""
    });
    await writeAgentConfig(proxyConfigDir, {
      agent: "You are a proxy router.",
      system: "For ambiguous requests, ask_user for clarification. For all work requests, use start_research_loop.",
      appendSystem: ""
    });

    const registry = await createRegistry({ workerConfigDir, managerConfigDir, sandboxDir });
    const proxy = await createProxyForTest(proxyConfigDir, registry, workerConfigDir, sandboxDir);

    let proxyText = "";
    try {
      await proxy.prompt("help");
      await proxy.waitForIdle();
      proxyText = extractAssistantText(proxy.state.messages);
    } finally {
      registry.shutdownAll();
      await rm(tempRoot, { recursive: true, force: true });
      tempRoots.delete(tempRoot);
    }

    assert.equal(proxyText.length > 0, true);
  });

  it("8.4 config reflection recreates Worker with updated APPEND_SYSTEM.md", { timeout: TEST_TIMEOUT_MS }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-e2e-reflect-"));
    tempRoots.add(tempRoot);

    const workerConfigDir = join(tempRoot, "agents", "worker");
    const managerConfigDir = join(tempRoot, "agents", "manager");
    const sandboxDir = join(tempRoot, "workspace");

    await mkdir(sandboxDir, { recursive: true });
    await mkdir(join(sandboxDir, "output"), { recursive: true });

    const initialAppend = "Initial worker style guidance.";
    await writeAgentConfig(workerConfigDir, {
      agent: "You are a worker agent.",
      system: "Create useful reports.",
      appendSystem: initialAppend
    });
    await writeAgentConfig(managerConfigDir, {
      agent: "You are a manager agent.",
      system: "When asked, update APPEND_SYSTEM.md by calling update_worker_config.",
      appendSystem: "Use measurable improvements in configuration changes."
    });

    const registry = await createRegistry({ workerConfigDir, managerConfigDir, sandboxDir });
    const initialWorker = await registry.get("worker");
    const initialPrompt = initialWorker.state.systemPrompt;

    let updatedAppend = "";
    let recreatedPrompt = "";
    try {
      const manager = await registry.get("manager");
      await manager.prompt("Update the worker configuration to require clearly structured reports with sections for title, summary, details, and sources. Use update_worker_config.");
      await manager.waitForIdle();

      registry.evict("worker");
      updatedAppend = await readFile(join(workerConfigDir, "APPEND_SYSTEM.md"), "utf-8");
      const recreatedWorker = await registry.get("worker");
      recreatedPrompt = recreatedWorker.state.systemPrompt;
    } finally {
      registry.shutdownAll();
      await rm(tempRoot, { recursive: true, force: true });
      tempRoots.delete(tempRoot);
    }

    assert.equal(updatedAppend.trim().length > 0, true);
    assert.notEqual(updatedAppend.trim(), initialAppend);
    assert.equal(recreatedPrompt.includes(updatedAppend.trim()), true);
    assert.notEqual(recreatedPrompt, initialPrompt);
  });
});
