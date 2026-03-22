import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

import { loadAgentConfig } from "../config/index.js";
import { createSandboxedTools } from "../tools/sandboxed-tools.js";
import { createWebSearchTool } from "../tools/web-search-tool.js";
import { createWebFetchTool } from "../tools/web-fetch-tool.js";

export interface WorkerAgentOptions {
  configDir: string;
  sandboxDir: string;
  model?: Model<any>;
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export async function createWorkerAgent(options: WorkerAgentOptions): Promise<Agent> {
  const systemPrompt = await loadAgentConfig(options.configDir);

  if (!options.model) {
    throw new Error("WorkerAgent requires a model. Pass the session model via options.model.");
  }

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: options.model
    },
    streamFn: options.streamFn ?? streamSimple,
    getApiKey: options.getApiKey
  });

  const tools = [...createSandboxedTools(options.sandboxDir), createWebSearchTool(), createWebFetchTool()];
  agent.setTools(tools);

  return agent;
}
