import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

const UTF8 = "utf-8";

async function writeFileVerified(filePath: string, content: string): Promise<void> {
  await writeFile(filePath, content, UTF8);
  const written = await readFile(filePath, UTF8);
  if (written !== content) {
    throw new Error(`Write verification failed for ${filePath}: content mismatch after write`);
  }
}

const EmptyParametersSchema = Type.Object({});
const ReadWorkProductParametersSchema = Type.Object({
  filename: Type.Optional(Type.String())
});
const UpdateWorkerConfigParametersSchema = Type.Object({
  content: Type.String(),
  reason: Type.String(),
  hypothesis: Type.String(),
  expectedEffect: Type.String(),
  llmModel: Type.String()
});
const EvaluateWorkProductParametersSchema = Type.Object({
  filename: Type.String()
});
const UpdateTaskPlanParametersSchema = Type.Object({
  operation: Type.Optional(Type.Union([
    Type.Literal("update-work-unit"),
    Type.Literal("add-l3"),
    Type.Literal("update-l3")
  ])),
  workUnitGoal: Type.Optional(Type.String({ description: "Target WorkUnit goal string" })),
  newStatus: Type.Union([Type.Literal("TODO"), Type.Literal("DOING"), Type.Literal("DONE")]),
  l3EntryId: Type.Optional(Type.String({ description: "Target L3 entry ID" })),
  l3Description: Type.Optional(Type.String({ description: "Description for a new L3 entry" })),
  note: Type.Optional(Type.String({ description: "Supplementary note" }))
});

type ReadWorkProductParameters = Static<typeof ReadWorkProductParametersSchema>;
type UpdateWorkerConfigParameters = Static<typeof UpdateWorkerConfigParametersSchema>;
type EvaluateWorkProductParameters = Static<typeof EvaluateWorkProductParametersSchema>;
type UpdateTaskPlanParameters = Static<typeof UpdateTaskPlanParametersSchema>;

async function readTextOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, UTF8);
  } catch {
    return "";
  }
}

async function listMarkdownFiles(dirPath: string): Promise<string[]> {
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function formatSection(title: string, content: string): string {
  return `## ${title}\n${content}`;
}

function summarizeChange(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "(empty)";
  }
  if (normalized.length <= 120) {
    return normalized;
  }
  return `${normalized.slice(0, 117)}...`;
}

export function createReadWorkerConfigTool(workerConfigDir: string): AgentTool<typeof EmptyParametersSchema> {
  return {
    name: "read_worker_config",
    label: "Read Worker Config",
    description: "Reads worker configuration files including skills.",
    parameters: EmptyParametersSchema,
    async execute() {
      const agentContent = await readTextOrEmpty(join(workerConfigDir, "agent.md"));
      const systemContent = await readTextOrEmpty(join(workerConfigDir, "system.md"));
      const appendContent = await readTextOrEmpty(join(workerConfigDir, "APPEND_SYSTEM.md"));
      const skillDir = join(workerConfigDir, "skills");
      const skillFiles = await listMarkdownFiles(skillDir);
      const skillSections = await Promise.all(
        skillFiles.map(async (file) => formatSection(`skills/${file}`, await readTextOrEmpty(join(skillDir, file))))
      );

      const text = [
        formatSection("agent.md", agentContent),
        formatSection("system.md", systemContent),
        ...skillSections,
        formatSection("APPEND_SYSTEM.md", appendContent)
      ].join("\n\n");

      return {
        content: [{ type: "text", text }],
        details: {
          workerConfigDir,
          skillCount: skillFiles.length
        }
      };
    }
  };
}

export function createReadWorkProductTool(workerSandboxDir: string): AgentTool<typeof ReadWorkProductParametersSchema> {
  return {
    name: "read_work_product",
    label: "Read Work Product",
    description: "Lists work product files or reads one file from output directory.",
    parameters: ReadWorkProductParametersSchema,
    async execute(_toolCallId: string, params: ReadWorkProductParameters) {
      const outputDir = join(workerSandboxDir, "output");
      if (!params.filename) {
        try {
          const entries = await readdir(outputDir, { withFileTypes: true });
          const files = entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .sort((a, b) => a.localeCompare(b));
          const text = files.length > 0 ? files.join("\n") : "No files found in output/.";
          return {
            content: [{ type: "text", text }],
            details: { mode: "list", count: files.length }
          };
        } catch {
          return {
            content: [{ type: "text", text: "No files found in output/." }],
            details: { mode: "list", count: 0 }
          };
        }
      }

      const filePath = join(outputDir, params.filename);
      const content = await readTextOrEmpty(filePath);
      const text = content || `File not found or empty: ${params.filename}`;
      return {
        content: [{ type: "text", text }],
        details: { mode: "read", filename: params.filename }
      };
    }
  };
}

export function createUpdateWorkerConfigTool(workerConfigDir: string): AgentTool<typeof UpdateWorkerConfigParametersSchema> {
  return {
    name: "update_worker_config",
    label: "Update Worker APPEND_SYSTEM",
    description: "Backs up and updates APPEND_SYSTEM.md and appends changelog entry.",
    parameters: UpdateWorkerConfigParametersSchema,
    async execute(_toolCallId: string, params: UpdateWorkerConfigParameters) {
      const appendPath = join(workerConfigDir, "APPEND_SYSTEM.md");
      const backupsDir = join(workerConfigDir, "backups");
      const changelogPath = join(workerConfigDir, "changelog.md");

      const oldContent = await readTextOrEmpty(appendPath);
      const timestampMs = Date.now();
      const timestampIso = new Date(timestampMs).toISOString();
      const backupFileName = `APPEND_SYSTEM.${timestampMs}.md`;
      await mkdir(backupsDir, { recursive: true });
      await writeFileVerified(join(backupsDir, backupFileName), oldContent);
      await writeFileVerified(appendPath, params.content);

      const changeSummary = `${summarizeChange(oldContent)} -> ${summarizeChange(params.content)}`;
      const entry = [
        `## [${timestampIso}]`,
        "- target_file: APPEND_SYSTEM.md",
        `- hypothesis: ${params.hypothesis}`,
        `- change_content: ${changeSummary}`,
        `- reason: ${params.reason}`,
        `- expected_effect: ${params.expectedEffect}`,
        `- llm_model: ${params.llmModel}`
      ].join("\n");

      const existingChangelog = await readTextOrEmpty(changelogPath);
      const changelogContent = existingChangelog.trim() ? `${existingChangelog}\n\n${entry}` : entry;
      await writeFileVerified(changelogPath, changelogContent);

      return {
        content: [{ type: "text", text: `Updated APPEND_SYSTEM.md and appended changelog at ${timestampIso}.` }],
        details: {
          backupFile: backupFileName,
          changelogPath
        }
      };
    }
  };
}

export function createEvaluateWorkProductTool(workerSandboxDir: string): AgentTool<typeof EvaluateWorkProductParametersSchema> {
  return {
    name: "evaluate_work_product",
    label: "Evaluate Work Product",
    description: "Returns work product content with a structured evaluation framework.",
    parameters: EvaluateWorkProductParametersSchema,
    async execute(_toolCallId: string, params: EvaluateWorkProductParameters) {
      const filePath = join(workerSandboxDir, "output", params.filename);
      const fileContent = await readTextOrEmpty(filePath);
      const text = [
        `# Work Product: ${params.filename}`,
        fileContent || `File not found or empty: ${params.filename}`,
        "",
        "# Evaluation Framework",
        "Evaluate the work product with these dimensions:",
        "1) Coverage: completeness against the requested scope and constraints.",
        "2) Accuracy: factual and logical correctness of claims and derivations.",
        "3) Structure: clarity, organization, coherence, and readability.",
        "4) Citations: evidence quality, source traceability, and reference completeness.",
        "",
        "Use this hypothesis-verification structure:",
        "- Hypothesis: what improvement/change should increase quality.",
        "- Verification: how to validate whether the hypothesis held.",
        "- Verdict: keep, revise, or rollback recommendation with concise rationale."
      ].join("\n");

      return {
        content: [{ type: "text", text }],
        details: {
          filename: params.filename
        }
      };
    }
  };
}

export function createReadChangelogTool(workerConfigDir: string): AgentTool<typeof EmptyParametersSchema> {
  return {
    name: "read_changelog",
    label: "Read Worker Changelog",
    description: "Reads worker changelog entries.",
    parameters: EmptyParametersSchema,
    async execute() {
      const changelog = await readTextOrEmpty(join(workerConfigDir, "changelog.md"));
      return {
        content: [{ type: "text", text: changelog }],
        details: { workerConfigDir }
      };
    }
  };
}

export function createReadTaskPlanTool(taskPlanPath: string): AgentTool<typeof EmptyParametersSchema> {
  return {
    name: "read_task_plan",
    label: "Read Task Plan",
    description: "Reads the current task plan (task-plan.md) with L1-L3 hierarchy and TODO/DOING/DONE status.",
    parameters: EmptyParametersSchema,
    async execute() {
      try {
        const content = await readFile(taskPlanPath, UTF8);
        return {
          content: [{ type: "text", text: content }],
          details: { path: taskPlanPath }
        };
      } catch {
        return {
          content: [{ type: "text", text: "タスク計画はまだ作成されていません。" }],
          details: { path: taskPlanPath }
        };
      }
    }
  };
}

function rewriteTaskPlanStatusLines(
  lines: string[],
  lineIndex: number,
  newStatus: "TODO" | "DOING" | "DONE",
  extras?: {
    qualityScore?: number;
    findingsFile?: string;
    startedAt?: string;
    completedAt?: string;
    note?: string;
  }
): string[] {
  const match = lines[lineIndex]?.match(/^(\s*)(-\s*)(TODO|DOING|DONE)(\s+\[[^\]]+\]\s+.+)$/);
  if (!match) {
    return lines;
  }

  const indent = match[1] ?? "";
  const metadataIndent = `${indent}  `;
  const metadataKeys = new Set(["品質スコア", "findingsFile", "開始時刻", "完了時刻", "note"]);

  lines[lineIndex] = `${indent}${match[2]}${newStatus}${match[4]}`;

  let removeAt = lineIndex + 1;
  while (removeAt < lines.length) {
    const nextLine = lines[removeAt] ?? "";
    if (!nextLine.startsWith(metadataIndent)) {
      break;
    }
    const keyMatch = nextLine.trim().match(/^[-]\s*([^:]+):/);
    const normalizedKey = keyMatch?.[1]?.trim() ?? "";
    if (!metadataKeys.has(normalizedKey)) {
      break;
    }
    lines.splice(removeAt, 1);
  }

  const extraLines: string[] = [];
  if (extras?.qualityScore !== undefined) {
    extraLines.push(`${metadataIndent}- 品質スコア: ${extras.qualityScore}/100`);
  }
  if (extras?.findingsFile) {
    extraLines.push(`${metadataIndent}- findingsFile: ${extras.findingsFile}`);
  }
  if (extras?.startedAt) {
    extraLines.push(`${metadataIndent}- 開始時刻: ${extras.startedAt}`);
  }
  if (extras?.completedAt) {
    extraLines.push(`${metadataIndent}- 完了時刻: ${extras.completedAt}`);
  }
  if (extras?.note) {
    extraLines.push(`${metadataIndent}- note: ${extras.note}`);
  }

  if (extraLines.length > 0) {
    lines.splice(lineIndex + 1, 0, ...extraLines);
  }

  return lines;
}

export function createUpdateTaskPlanTool(taskPlanPath: string): AgentTool<typeof UpdateTaskPlanParametersSchema> {
  return {
    name: "update_task_plan",
    label: "Update Task Plan",
    description: "Updates task plan status (TODO/DOING/DONE) or adds L3 entries.",
    parameters: UpdateTaskPlanParametersSchema,
    async execute(_toolCallId: string, params: UpdateTaskPlanParameters) {
      let content: string;
      try {
        content = await readFile(taskPlanPath, UTF8);
      } catch {
        return {
          content: [{ type: "text", text: `WorkUnit not found: ${params.workUnitGoal ?? params.l3EntryId ?? "unknown"}` }],
          details: { path: taskPlanPath, updated: false }
        };
      }

      const lines = content.split(/\r?\n/);
      const operation = params.operation ?? "update-work-unit";

      if (operation === "update-l3") {
        if (!params.l3EntryId) {
          return {
            content: [{ type: "text", text: "WorkUnit not found: unknown" }],
            details: { path: taskPlanPath, updated: false }
          };
        }
        const lineIndex = lines.findIndex((line) => line.includes(`[${params.l3EntryId}]`) && /-\s*(TODO|DOING|DONE)\s+\[L3-/.test(line));
        if (lineIndex < 0) {
          return {
            content: [{ type: "text", text: `WorkUnit not found: ${params.l3EntryId}` }],
            details: { path: taskPlanPath, updated: false }
          };
        }
        const updated = rewriteTaskPlanStatusLines(lines, lineIndex, params.newStatus, { note: params.note });
        await writeFile(taskPlanPath, updated.join("\n"), UTF8);
        return {
          content: [{ type: "text", text: `Updated task-plan.md: ${params.l3EntryId} → ${params.newStatus}` }],
          details: { path: taskPlanPath, updated: true }
        };
      }

      const workUnitGoal = params.workUnitGoal ?? "";
      const targetLabel = workUnitGoal || params.l3EntryId || "unknown";
      const lineIndex = workUnitGoal.length > 0
        ? lines.findIndex((line) => line.includes(workUnitGoal) && /-\s*(TODO|DOING|DONE)\s+\[/.test(line))
        : -1;

      if (lineIndex < 0) {
        return {
          content: [{ type: "text", text: `WorkUnit not found: ${targetLabel}` }],
          details: { path: taskPlanPath, updated: false }
        };
      }

      const updated = rewriteTaskPlanStatusLines(lines, lineIndex, params.newStatus, {
        note: operation === "add-l3" ? undefined : params.note
      });

      if (operation === "add-l3") {
        const targetIndent = lines[lineIndex]!.match(/^(\s*)/)?.[1] ?? "";
        const metadataIndent = `${targetIndent}  `;
        const entryId = params.l3EntryId ?? "L3-000";
        const description = params.l3Description ?? params.note ?? "";
        const insertionIndex = lineIndex + 1;
        const l3Lines = [`${metadataIndent}- ${params.newStatus} [${entryId}] ${description}`.trimEnd()];
        if (params.note) {
          l3Lines.push(`${metadataIndent}  - note: ${params.note}`);
        }
        updated.splice(insertionIndex, 0, ...l3Lines);
      }

      await writeFile(taskPlanPath, updated.join("\n"), UTF8);

      return {
        content: [{ type: "text", text: `Updated task-plan.md: ${params.workUnitGoal ?? params.l3EntryId ?? "unknown"} → ${params.newStatus}` }],
        details: { path: taskPlanPath, updated: true }
      };
    }
  };
}
