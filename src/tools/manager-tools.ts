import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

const UTF8 = "utf-8";

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

type ReadWorkProductParameters = Static<typeof ReadWorkProductParametersSchema>;
type UpdateWorkerConfigParameters = Static<typeof UpdateWorkerConfigParametersSchema>;
type EvaluateWorkProductParameters = Static<typeof EvaluateWorkProductParametersSchema>;

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
      await writeFile(join(backupsDir, backupFileName), oldContent, UTF8);
      await writeFile(appendPath, params.content, UTF8);

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
      await writeFile(changelogPath, changelogContent, UTF8);

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
