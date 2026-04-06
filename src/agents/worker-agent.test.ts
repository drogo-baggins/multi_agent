import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import { Agent } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";

import { buildWorkerTools, createWorkerAgent } from "./worker-agent.js";
import { createHumanToolStatusController } from "../tools/human-tool-status-ref.js";

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
    assert.ok(agent.state.systemPrompt.includes("worker-agent"));
    assert.ok(agent.state.systemPrompt.includes("worker-system"));
    assert.ok(agent.state.systemPrompt.includes("worker-append"));
    assert.ok(agent.state.systemPrompt.includes("現在日付"));
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

describe("worker-agent – buildWorkerTools", () => {
  it("returns web_search and web_fetch in auto mode", () => {
    const tools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "auto" });
    const names = tools.map(t => t.name);
    assert.ok(names.includes("web_search"));
    assert.ok(names.includes("web_fetch"));
  });

  it("returns web_search and web_fetch also in human mode (same names)", () => {
    const tools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "human", cdpCallbacks: createHumanToolStatusController() });
    const names = tools.map(t => t.name);
    assert.ok(names.includes("web_search"));
    assert.ok(names.includes("web_fetch"));
  });

  it("uses human label in human mode", () => {
    const tools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "human", cdpCallbacks: createHumanToolStatusController() });
    const webSearch = tools.find(t => t.name === "web_search");
    assert.ok(webSearch?.label?.includes("Human"));
  });

  it("uses non-human label in auto mode", () => {
    const tools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "auto" });
    const webSearch = tools.find(t => t.name === "web_search");
    assert.ok(!webSearch?.label?.includes("Human"));
  });

  it("defaults to auto tools when searchMode is undefined", () => {
    const tools = buildWorkerTools({ sandboxDir: "/tmp" });
    const webSearch = tools.find(t => t.name === "web_search");
    assert.ok(!webSearch?.label?.includes("Human"));
  });

  it("returns the same total tool count in auto and human modes", () => {
    const autoTools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "auto" });
    const humanTools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "human", cdpCallbacks: createHumanToolStatusController() });
    assert.equal(autoTools.length, humanTools.length);
  });

  it("auto and human mode web_search are distinct instances", () => {
    const autoTools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "auto" });
    const humanTools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "human", cdpCallbacks: createHumanToolStatusController() });
    const autoSearch = autoTools.find(t => t.name === "web_search");
    const humanSearch = humanTools.find(t => t.name === "web_search");
    assert.notEqual(autoSearch, humanSearch);
  });

  it("throws when human mode is requested without cdpCallbacks", () => {
    assert.throws(() => buildWorkerTools({ sandboxDir: "/tmp", searchMode: "human" }), /cdpCallbacks/);
  });
});
