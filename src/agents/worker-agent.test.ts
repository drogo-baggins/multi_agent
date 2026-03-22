import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

import { createWorkerAgent } from "./worker-agent.js";

const testModel = getModel("anthropic", "claude-sonnet-4-20250514");
import { createWebSearchTool } from "../tools/web-search-tool.js";
import { createWebFetchTool } from "../tools/web-fetch-tool.js";

describe("worker agent factory", () => {
  let tempRoot = "";

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-worker-"));
  });

  after(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("creates Agent with loaded system prompt", async () => {
    const configDir = join(tempRoot, "worker-config");
    const sandboxDir = join(tempRoot, "workspace");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "agent.md"), "worker-agent");
    await writeFile(join(configDir, "system.md"), "worker-system");
    await writeFile(join(configDir, "APPEND_SYSTEM.md"), "worker-append");

    const agent = await createWorkerAgent({ configDir, sandboxDir, model: testModel });

    assert.ok(agent instanceof Agent);
    assert.equal(agent.state.systemPrompt, "worker-agent\n\nworker-system\n\nworker-append");
  });

  it("registers web_search and coding tools", async () => {
    const configDir = join(tempRoot, "worker-config-tools");
    const sandboxDir = join(tempRoot, "workspace-tools");
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "system.md"), "worker-system");

    const agent = await createWorkerAgent({ configDir, sandboxDir, model: testModel });

    const toolNames = new Set(agent.state.tools.map((tool) => tool.name));
    assert.equal(toolNames.has("web_search"), true);
    assert.equal(toolNames.has("web_fetch"), true);
    assert.equal(toolNames.has("read"), true);
    assert.equal(toolNames.has("bash"), true);
    assert.equal(toolNames.has("edit"), true);
    assert.equal(toolNames.has("write"), true);
  });
});

describe("web tools", () => {
  it("creates web_search tool metadata", () => {
    const tool = createWebSearchTool();

    assert.equal(tool.name, "web_search");
    assert.equal(tool.label, "Web Search");
    assert.equal(tool.description, "Searches the web for relevant information.");
  });

  it("creates web_fetch tool metadata", () => {
    const tool = createWebFetchTool();

    assert.equal(tool.name, "web_fetch");
    assert.equal(tool.label, "Web Fetch");
    assert.equal(tool.description, "Fetches a web page and extracts its content as readable markdown.");
  });
});
