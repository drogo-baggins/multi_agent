import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import type { AgentEvent, AgentToolResult } from "@mariozechner/pi-agent-core";
import { getModel, streamSimple } from "@mariozechner/pi-ai";

import { createManagerAgent } from "../agents/manager-agent.js";
import { createWorkerAgent } from "../agents/worker-agent.js";
import { AgentRegistry } from "../communication/agent-registry.js";

const API_KEY = process.env["ANTHROPIC_API_KEY"];
const SKIP_REASON = "ANTHROPIC_API_KEY not set — skipping POC validation tests";
const TEST_TIMEOUT_MS = 180_000;

const testModel = getModel("anthropic", "claude-sonnet-4-20250514");
const getApiKey = (provider: string): string | undefined => process.env[`${provider.toUpperCase()}_API_KEY`];

function extractTextOrThrow(result: AgentToolResult<void>): string {
  const text = result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();

  if ("isError" in result && result.isError === true) {
    throw new Error(text || "Agent invocation failed");
  }

  return text;
}

function countParagraphs(text: string): number {
  return text
    .split(/\n\s*\n/g)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0).length;
}

function countBulletLines(text: string): number {
  return text
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
}

function isStructurallyDifferent(first: string, second: string): boolean {
  if (first.trim() === second.trim()) {
    return false;
  }

  const lengthDelta = Math.abs(second.length - first.length);
  const paragraphDelta = Math.abs(countParagraphs(second) - countParagraphs(first));
  const bulletDelta = Math.abs(countBulletLines(second) - countBulletLines(first));
  return lengthDelta >= 40 || paragraphDelta >= 1 || bulletDelta >= 2;
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
      model: testModel,
      streamFn: streamSimple,
      getApiKey
    });
  });

  return registry;
}

describe("POC validation tests", { skip: !API_KEY ? SKIP_REASON : undefined }, () => {
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

  it("11.1 POC-1 detects quality problems in intentionally bad worker output", { timeout: TEST_TIMEOUT_MS }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-poc-detect-"));
    tempRoots.add(tempRoot);

    const workerConfigDir = join(tempRoot, "agents", "worker");
    const managerConfigDir = join(tempRoot, "agents", "manager");
    const sandboxDir = join(tempRoot, "workspace");

    await mkdir(sandboxDir, { recursive: true });
    await mkdir(join(sandboxDir, "output"), { recursive: true });

    await writeAgentConfig(workerConfigDir, {
      agent: "You are a worker agent.",
      system: "Write only one sentence per report.",
      appendSystem: "Keep output extremely minimal."
    });
    await writeAgentConfig(managerConfigDir, {
      agent: "You are a manager agent.",
      system: "Use your tools as needed and follow user instructions exactly.",
      appendSystem: "When asked for structured evaluation output, return only that format."
    });

    const registry = await createRegistry({ workerConfigDir, managerConfigDir, sandboxDir });
    const managerToolStarts: string[] = [];

    try {
      const worker = await registry.get("worker");
      const manager = await registry.get("manager");

      const unsubscribe = manager.subscribe((event: AgentEvent) => {
        if (event.type === "tool_execution_start") {
          managerToolStarts.push(event.toolName);
        }
      });

      try {
        await invokeAgent(
          worker,
          "Write a report about common software testing strategies. Save it to output/report.md and keep it to one sentence."
        );

        const reportFile = await readFile(join(sandboxDir, "output", "report.md"), "utf-8");
        assert.equal(reportFile.trim().length > 0, true);

        const evaluationResult = await invokeAgent(
          manager,
          [
            "First call evaluate_work_product with filename report.md.",
            "Then respond ONLY with this exact structured format:",
            "## Quality Score",
            "[0-100 number]",
            "",
            "## Summary",
            "[1-3 sentence summary]",
            "",
            "## Issues",
            "[For each issue:]",
            "Category: [coverage|accuracy|structure|citations|other]",
            "Description: [what the issue is]",
            "Evidence: [specific evidence from the work product]",
            "Cause: [config|task-difficulty|llm-limitation]"
          ].join("\n")
        );

        const parsed = parseEvaluationReport(extractTextOrThrow(evaluationResult));
        const foundQualityProblems = parsed.issues.length >= 1 || parsed.qualityScore < 80;

        assert.equal(managerToolStarts.includes("evaluate_work_product"), true);
        assert.equal(foundQualityProblems, true);
      } finally {
        unsubscribe();
      }
    } finally {
      registry.shutdownAll();
      await rm(tempRoot, { recursive: true, force: true });
      tempRoots.delete(tempRoot);
    }
  });

  it("11.2 POC-2 manager updates APPEND_SYSTEM.md and worker behavior changes", { timeout: TEST_TIMEOUT_MS }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-poc-adjust-"));
    tempRoots.add(tempRoot);

    const workerConfigDir = join(tempRoot, "agents", "worker");
    const managerConfigDir = join(tempRoot, "agents", "manager");
    const sandboxDir = join(tempRoot, "workspace");

    await mkdir(sandboxDir, { recursive: true });
    await mkdir(join(sandboxDir, "output"), { recursive: true });

    const initialAppend = "Only respond with bullet points, no detail.";
    await writeAgentConfig(workerConfigDir, {
      agent: "You are a worker agent.",
      system: "Produce requested work products.",
      appendSystem: initialAppend
    });
    await writeAgentConfig(managerConfigDir, {
      agent: "You are a manager agent.",
      system: "For improvement requests, inspect and update worker config using update_worker_config.",
      appendSystem: "Prefer concrete APPEND_SYSTEM.md updates that improve structure and detail."
    });

    const registry = await createRegistry({ workerConfigDir, managerConfigDir, sandboxDir });
    const managerToolStarts: string[] = [];

    try {
      const worker = await registry.get("worker");
      const manager = await registry.get("manager");

      const unsubscribe = manager.subscribe((event: AgentEvent) => {
        if (event.type === "tool_execution_start") {
          managerToolStarts.push(event.toolName);
        }
      });

      try {
        const task = "Write a short report on modern software architecture tradeoffs.";
        const firstWorkProduct = extractTextOrThrow(await invokeAgent(worker, task));

        const request = formatImprovementRequest({
          issueCategory: "structure",
          issueEvidence: "Output is terse and list-like with limited explanation.",
          workProductExcerpt: firstWorkProduct.slice(0, 280) || "N/A",
          relatedConfigSection: initialAppend,
          improvementDirection: "Allow paragraph-based responses with concise headings and explanations.",
          userFeedback: "Need a clearer and more detailed report style."
        });

        await invokeAgent(
          manager,
          [
            "Apply the following improvement request.",
            "You must use update_worker_config to update APPEND_SYSTEM.md.",
            "After the update, summarize what changed.",
            "",
            request
          ].join("\n")
        );

        const updatedAppend = await readFile(join(workerConfigDir, "APPEND_SYSTEM.md"), "utf-8");
        assert.notEqual(updatedAppend.trim(), initialAppend);
        assert.equal(managerToolStarts.includes("update_worker_config"), true);

        registry.evict("worker");
        const recreatedWorker = await registry.get("worker");
        const secondWorkProduct = extractTextOrThrow(await invokeAgent(recreatedWorker, task));

        assert.equal(secondWorkProduct.trim().length > 0, true);
        assert.equal(isStructurallyDifferent(firstWorkProduct, secondWorkProduct), true);
      } finally {
        unsubscribe();
      }
    } finally {
      registry.shutdownAll();
      await rm(tempRoot, { recursive: true, force: true });
      tempRoots.delete(tempRoot);
    }
  });

  it("11.3 POC-3 persistence loop converges or exits cleanly with automated feedback", { timeout: TEST_TIMEOUT_MS }, async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "pi-agent-poc-loop-"));
    tempRoots.add(tempRoot);

    const workerConfigDir = join(tempRoot, "agents", "worker");
    const managerConfigDir = join(tempRoot, "agents", "manager");
    const sandboxDir = join(tempRoot, "workspace");

    await mkdir(sandboxDir, { recursive: true });
    await mkdir(join(sandboxDir, "output"), { recursive: true });

    await writeAgentConfig(workerConfigDir, {
      agent: "You are a worker agent.",
      system: "Provide useful reports, but keep them concise.",
      appendSystem: "Prefer short responses with limited structure."
    });
    await writeAgentConfig(managerConfigDir, {
      agent: "You are a manager agent.",
      system: "Evaluate worker quality and apply focused config improvements when requested.",
      appendSystem: "Use update_worker_config for actionable APPEND_SYSTEM.md changes."
    });

    const registry = await createRegistry({ workerConfigDir, managerConfigDir, sandboxDir });

    try {
      const iterationReports: string[] = [];
      const callbacks = createLoopCallbacks({
        registry,
        workerConfigDir,
        onIterationReport: (report) => {
          iterationReports.push(report);
        }
      });

      const customCallbacks: LoopCallbacks = {
        ...callbacks,
        getUserFeedback: async (_workProduct: string, evaluation: EvaluationReport, iteration: number): Promise<UserFeedback> => {
          if (evaluation.qualityScore >= 60) {
            return { type: "approved" };
          }
          if (iteration >= 3) {
            return { type: "interrupt" };
          }
          return { type: "improve", feedback: "Please improve overall quality, structure, and depth." };
        }
      };

      const task = "Write a concise report on tradeoffs between static and dynamic typing.";
      const loopStart = Date.now();
      const results = await runPersistenceLoop(task, customCallbacks, { maxIterations: 3, iterationTimeoutMs: 120_000 });
      const totalMs = Date.now() - loopStart;
      const perIterationMs = results.map((result) => result.latencyMs.totalMs);

      console.log(`[POC-3] total=${totalMs}ms iterations=${results.length} perIteration=${perIterationMs.join(",")}`);

      assert.equal(results.length >= 1, true);
      assert.equal(iterationReports.length >= 1, true);
      assert.equal(perIterationMs.every((ms) => Number.isFinite(ms) && ms >= 0), true);

      const finalOutcome = results[results.length - 1]?.outcome;
      assert.equal(
        finalOutcome === "user-approved" || finalOutcome === "user-interrupted" || finalOutcome === "max-iterations" || finalOutcome === "timeout",
        true
      );

      const finalConfig = await loadAgentConfig(workerConfigDir);
      assert.equal(finalConfig.trim().length > 0, true);
    } finally {
      registry.shutdownAll();
      await rm(tempRoot, { recursive: true, force: true });
      tempRoots.delete(tempRoot);
    }
  });
});
