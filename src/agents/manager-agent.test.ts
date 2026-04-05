import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

import { createManagerAgent } from "./manager-agent.js";

const testModel = getModel("anthropic", "claude-sonnet-4-20250514");

describe("manager agent factory", () => {
  let tempRoot = "";

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-manager-"));
  });

  after(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates Agent with loaded manager system prompt", async () => {
    const configDir = join(tempRoot, "manager-config");
    const workerConfigDir = join(tempRoot, "worker-config");
    const sandboxDir = join(tempRoot, "workspace");
    await mkdir(configDir, { recursive: true });
    await mkdir(workerConfigDir, { recursive: true });
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(join(configDir, "agent.md"), "manager-agent");
    await writeFile(join(configDir, "system.md"), "manager-system");
    await writeFile(join(configDir, "APPEND_SYSTEM.md"), "manager-append");

    const agent = await createManagerAgent({ configDir, workerConfigDir, sandboxDir, model: testModel });

    assert.ok(agent instanceof Agent);
    assert.ok(agent.state.systemPrompt.includes("manager-agent"));
    assert.ok(agent.state.systemPrompt.includes("manager-system"));
    assert.ok(agent.state.systemPrompt.includes("manager-append"));
    assert.ok(agent.state.systemPrompt.includes("現在日付"));
  });

  it("registers manager tools", async () => {
    const configDir = join(tempRoot, "manager-config-tools");
    const workerConfigDir = join(tempRoot, "worker-config-tools");
    const sandboxDir = join(tempRoot, "workspace-tools");
    const logsDir = join(tempRoot, "logs-tools");
    await mkdir(configDir, { recursive: true });
    await mkdir(workerConfigDir, { recursive: true });
    await mkdir(sandboxDir, { recursive: true });
    await writeFile(join(configDir, "system.md"), "manager-system");

    const agent = await createManagerAgent({ configDir, workerConfigDir, sandboxDir, logsDir, model: testModel });
    const toolNames = new Set(agent.state.tools.map((tool) => tool.name));

    assert.equal(toolNames.has("read_worker_config"), true);
    assert.equal(toolNames.has("read_work_product"), true);
    assert.equal(toolNames.has("update_worker_config"), true);
    assert.equal(toolNames.has("evaluate_work_product"), true);
    assert.equal(toolNames.has("read_changelog"), true);
    assert.equal(toolNames.has("read_task_plan"), true);
    assert.equal(toolNames.has("update_task_plan"), true);
  });
});
