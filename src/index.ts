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
        const rawTask = taskMatch?.[1]?.trim();
        // Strip any accumulated resume suffixes to recover the original task string
        const RESUME_MARKER = "（前回の作業が中断されています";
        const markerIdx = rawTask?.indexOf(RESUME_MARKER) ?? -1;
        const task = rawTask ? (markerIdx >= 0 ? rawTask.slice(0, markerIdx).trim() : rawTask) : undefined;
        if (task) {
          // Read ALL progress*.md files. Include sections from those NOT marked 完了,
          // so the snapshot reflects the current live investigation, not the completed original task.
          let progressSnapshot = "";
          try {
            const { readdir: readdirFn } = await import("node:fs/promises");
            const outputDir = join(projectRoot, "workspace", "output");
            const allFiles = (await readdirFn(outputDir))
              .filter((f) => f.startsWith("progress") && f.endsWith(".md"))
              .sort();

            const snapshotParts: string[] = [];
            for (const file of allFiles) {
              try {
                const content = await readFile(join(outputDir, file), "utf-8");
                // First occurrence of 現在の状態 determines whether this file is complete
                const stateMatch = content.match(/## 現在の状態\n([\s\S]*?)(?=\n## |\n---|$)/);
                const stateText = stateMatch?.[1] ?? "";
                const isFileDone = stateText.includes("完了");
                if (!isFileDone) {
                  const subtaskMatch = content.match(/## サブタスク一覧\n([\s\S]*?)(?=\n## |\n---|$)/);
                  const titleMatch = content.match(/^#\s+(.+)$/m);
                  const title = titleMatch?.[1] ?? file;
                  const subtasks = subtaskMatch ? `## サブタスク一覧\n${subtaskMatch[1].trim()}` : "";
                  const state = stateMatch ? `## 現在の状態\n${stateText.trim()}` : "";
                  snapshotParts.push(`### ${title} (${file})\n${[subtasks, state].filter(Boolean).join("\n\n")}`);
                }
              } catch { /* skip unreadable file */ }
            }
            progressSnapshot = snapshotParts.join("\n\n---\n\n");
          } catch {
            // No output dir yet — use generic resume message
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
