import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

import { loadAgentConfig } from "../config/index.js";
import {
  createEvaluateWorkProductTool,
  createReadChangelogTool,
  createReadWorkProductTool,
  createReadWorkerConfigTool,
  createUpdateWorkerConfigTool
} from "../tools/manager-tools.js";

export interface ManagerAgentOptions {
  configDir: string;
  workerConfigDir: string;
  sandboxDir: string;
  model?: Model<any>;
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
}

export async function createManagerAgent(options: ManagerAgentOptions): Promise<Agent> {
  const systemPrompt = await loadAgentConfig(options.configDir);

  if (!options.model) {
    throw new Error("ManagerAgent requires a model. Pass the session model via options.model.");
  }

  const agent = new Agent({
    initialState: {
      systemPrompt,
      model: options.model
    },
    streamFn: options.streamFn ?? streamSimple,
    getApiKey: options.getApiKey
  });

  agent.setTools([
    createReadWorkerConfigTool(options.workerConfigDir),
    createReadWorkProductTool(options.sandboxDir),
    createUpdateWorkerConfigTool(options.workerConfigDir),
    createEvaluateWorkProductTool(options.sandboxDir),
    createReadChangelogTool(options.workerConfigDir)
  ]);

  return agent;
}
