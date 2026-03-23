import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createAgentSession,
  InteractiveMode,
  DefaultResourceLoader,
  codingTools
} from "@mariozechner/pi-coding-agent";

import { createWorkerAgent } from "./agents/worker-agent.js";
import { createManagerAgent } from "./agents/manager-agent.js";
import { resolveAgentModel } from "./agents/resolve-agent-model.js";
import { AgentRegistry } from "./communication/agent-registry.js";
import { createCustomToolDefinitions } from "./tools/tool-definitions.js";
import { loadEnvFile } from "./env.js";

const filename = fileURLToPath(import.meta.url);
const srcDir = dirname(filename);
const projectRoot = dirname(srcDir);

const workerConfigDir = join(projectRoot, "agents", "worker");
const managerConfigDir = join(projectRoot, "agents", "manager");
const proxySystemPromptPath = join(projectRoot, "agents", "proxy", "system.md");
const sandboxDir = join(projectRoot, "workspace");
const logsDir = join(projectRoot, "workspace", "logs");

async function main(): Promise<void> {
  loadEnvFile();

  const registry = new AgentRegistry();

  // Session reference — set after createAgentSession, read lazily by registry factories.
  // Safe because registry.get() only runs during tool execution, which is after session creation.
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];

  const getApiKey = async (provider: string): Promise<string | undefined> => {
    return session.modelRegistry.getApiKeyForProvider(provider);
  };

  registry.register("worker", async () => {
    return createWorkerAgent({
      configDir: workerConfigDir,
      sandboxDir,
      model: resolveAgentModel("worker", session.model, session.modelRegistry),
      getApiKey
    });
  });

  registry.register("manager", async () => {
    return createManagerAgent({
      configDir: managerConfigDir,
      workerConfigDir,
      sandboxDir,
      model: resolveAgentModel("manager", session.model, session.modelRegistry),
      getApiKey
    });
  });

  const customTools = createCustomToolDefinitions({ registry, workerConfigDir, logsDir });

  const resourceLoader = new DefaultResourceLoader({
    cwd: projectRoot,
    systemPrompt: proxySystemPromptPath
  });
  await resourceLoader.reload();

  const result = await createAgentSession({
    cwd: projectRoot,
    tools: codingTools,
    customTools,
    resourceLoader
  });

  session = result.session;

  const mode = new InteractiveMode(session, { modelFallbackMessage: result.modelFallbackMessage });
  await mode.run();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
