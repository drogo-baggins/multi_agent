import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export interface AgentConfigLoadOptions {
  skills?: string[];
}

export interface AgentConfigPaths {
  agent: string;
  system: string;
  appendSystem: string;
  skillsDir: string;
}

const UTF8 = "utf-8";

function toSkillFileName(skill: string): string {
  return skill.endsWith(".md") ? skill : `${skill}.md`;
}

async function readIfExists(filePath: string): Promise<string | null> {
  try {
    await access(filePath);
    return await readFile(filePath, UTF8);
  } catch {
    return null;
  }
}

async function listAllSkillFiles(skillsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function loadSkillSections(skillsDir: string, skills?: string[]): Promise<string[]> {
  const skillFiles = skills ? skills.map(toSkillFileName) : await listAllSkillFiles(skillsDir);
  const sections = await Promise.all(skillFiles.map((skillFile) => readIfExists(join(skillsDir, skillFile))));
  return sections.filter((section): section is string => section !== null);
}

export async function loadAgentConfig(agentDir: string, skills?: string[]): Promise<string> {
  const paths: AgentConfigPaths = {
    agent: join(agentDir, "agent.md"),
    system: join(agentDir, "system.md"),
    appendSystem: join(agentDir, "APPEND_SYSTEM.md"),
    skillsDir: join(agentDir, "skills")
  };

  const sections: string[] = [];
  const agentSection = await readIfExists(paths.agent);
  if (agentSection !== null) {
    sections.push(agentSection);
  }

  const systemSection = await readIfExists(paths.system);
  if (systemSection !== null) {
    sections.push(systemSection);
  }

  sections.push(...(await loadSkillSections(paths.skillsDir, skills)));

  const appendSection = await readIfExists(paths.appendSystem);
  if (appendSection !== null) {
    sections.push(appendSection);
  }

  const now = new Date();
  const currentDate = now.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: "Asia/Tokyo"
  });
  const dateHeader =
    `# システム情報\n` +
    `現在日付: ${currentDate}（JST）\n` +
    `この日付はシステムが実行時に設定した正確な値です。レポート・サブタスク結果・進捗ファイル内の日付記载にはこの値を使用し、学習データに基づく推測の日付を使用してはならない。`;

  return [dateHeader, ...sections].join("\n\n");
}
