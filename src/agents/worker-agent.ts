import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

import { loadAgentConfig } from "../config/index.js";
import { createSandboxedTools } from "../tools/sandboxed-tools.js";
import { createWebSearchTool } from "../tools/web-search-tool.js";
import { createWebFetchTool } from "../tools/web-fetch-tool.js";
import { createHumanSearchTool } from "../tools/human-search-tool.js";
import { createHumanFetchTool } from "../tools/human-fetch-tool.js";
import type { HumanToolCdpCallbacks } from "../tools/human-tool-status-ref.js";
import type { SearchMode } from "../search/search-config.js";

export interface WorkerAgentOptions {
  configDir: string;
  sandboxDir: string;
  model?: Model<any>;
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  searchMode?: SearchMode;
  cdpCallbacks?: HumanToolCdpCallbacks;
}

function createNoopCdpCallbacks(): HumanToolCdpCallbacks {
  return {
    onPromptReady: () => undefined
  };
}

export function buildWorkerTools(options: Pick<WorkerAgentOptions, "sandboxDir" | "searchMode" | "cdpCallbacks">) {
  const cdpCallbacks = options.cdpCallbacks ?? createNoopCdpCallbacks();
  if (options.searchMode === "human" && !options.cdpCallbacks) {
    throw new Error("Human search mode requires cdpCallbacks.");
  }

  const webTools =
    options.searchMode === "human"
      ? [createHumanSearchTool(cdpCallbacks), createHumanFetchTool(cdpCallbacks)]
      : [createWebSearchTool(), createWebFetchTool()];
  return [...createSandboxedTools(options.sandboxDir), ...webTools];
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

  agent.setTools(buildWorkerTools(options));

  return agent;
}
