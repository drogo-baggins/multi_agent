import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

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
import { loadSearchConfig } from "./search/search-config.js";

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
  const searchConfig = loadSearchConfig();

  const registry = new AgentRegistry();

  // Session reference — set after createAgentSession, read lazily by registry factories.
  // Safe because registry.get() only runs during tool execution, which is after session creation.
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"];

  const getApiKey = async (provider: string): Promise<string | undefined> => {
    return session.modelRegistry.getApiKeyForProvider(provider);
  };

  registry.register("worker", async () => {
    if (!session.model) throw new Error("No model selected. Use /model to select a model.");
    return createWorkerAgent({
      configDir: workerConfigDir,
      sandboxDir,
      model: resolveAgentModel("worker", session.model, session.modelRegistry),
      getApiKey,
      searchMode: searchConfig.mode
    });
  });

  registry.register("manager", async () => {
    if (!session.model) throw new Error("No model selected. Use /model to select a model.");
    return createManagerAgent({
      configDir: managerConfigDir,
      workerConfigDir,
      sandboxDir,
      model: resolveAgentModel("manager", session.model, session.modelRegistry),
      getApiKey
    });
  });

  const customTools = createCustomToolDefinitions({ registry, workerConfigDir, logsDir });

  // Detect aborted session via the most recent audit log (system-written, always created by
  // start_research_loop). If the most recent log lacks "## Synthesis Complete" it was aborted.
  const logsDir2 = join(projectRoot, "workspace", "logs");
  let initialMessage: string | undefined;
  try {
    const { readdir } = await import("node:fs/promises");
    const logFiles = (await readdir(logsDir2))
      .filter((f) => f.startsWith("manager-audit-") && f.endsWith(".md"))
      .sort();                                      // lexicographic = chronological (ISO timestamp)
    const latestLog = logFiles[logFiles.length - 1];
    if (latestLog) {
      const logContent = await readFile(join(logsDir2, latestLog), "utf-8");
      const isComplete = logContent.includes("## Synthesis Complete");
      if (!isComplete) {
        const taskMatch = logContent.match(/^\*\*Task\*\*:\s*(.+)$/m);
        const task = taskMatch?.[1]?.trim();
        if (task) {
          // Read progress.md to embed concrete completion state in the resume message.
          // Extract only サブタスク一覧 + 現在の状態 (first occurrence = top-level task).
          let progressSnapshot = "";
          try {
            const progressPath = join(projectRoot, "workspace", "output", "progress.md");
            const progressContent = await readFile(progressPath, "utf-8");
            const snapshotParts: string[] = [];
            const subtaskMatch = progressContent.match(/## サブタスク一覧\n([\s\S]*?)(?=\n## |\n---)/);
            const stateMatch = progressContent.match(/## 現在の状態\n([\s\S]*?)(?=\n## |\n---)/);
            if (subtaskMatch) snapshotParts.push(`## サブタスク一覧\n${subtaskMatch[1].trim()}`);
            if (stateMatch) snapshotParts.push(`## 現在の状態\n${stateMatch[1].trim()}`);
            progressSnapshot = snapshotParts.join("\n\n");
          } catch {
            // No progress.md yet — use generic resume message
          }

          if (progressSnapshot) {
            initialMessage =
              `${task}\n\n前回の作業が中断されています。前回の進捗は以下の通りです:\n\n${progressSnapshot}\n\n` +
              `完了済み（[x]）のサブタスクはスキップし、未完了（[ ]）のサブタスクから作業を再開してください。`;
          } else {
            initialMessage =
              `${task}（前回の作業が中断されています。output/ 配下に前回の進捗があります。前回の続きから作業してください）`;
          }
        }
      }
    }
  } catch {
    // No logs dir or no logs — normal startup
  }

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

  const mode = new InteractiveMode(session, { modelFallbackMessage: result.modelFallbackMessage, initialMessage });
  await mode.run();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});
