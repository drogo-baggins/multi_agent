import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface AgentConfigTemplateFiles {
  agent: string;
  system: string;
  appendSystem: string;
  changelog: string;
}

async function writeIfMissing(filePath: string, content = ""): Promise<void> {
  try {
    await access(filePath);
  } catch {
    await writeFile(filePath, content, "utf-8");
  }
}

export async function initializeAgentConfig(agentDir: string, agentName: string): Promise<void> {
  await mkdir(agentDir, { recursive: true });
  await mkdir(join(agentDir, "skills"), { recursive: true });
  await mkdir(join(agentDir, "backups"), { recursive: true });

  const files: AgentConfigTemplateFiles = {
    agent: join(agentDir, "agent.md"),
    system: join(agentDir, "system.md"),
    appendSystem: join(agentDir, "APPEND_SYSTEM.md"),
    changelog: join(agentDir, "changelog.md")
  };

  const changelogTemplate = `# Changelog (${agentName})

## Entry Template
- timestamp:
- target_file:
- change_content:
- reason:
- expected_effect:
- llm_model:
`;

  await writeIfMissing(files.agent);
  await writeIfMissing(files.system);
  await writeIfMissing(files.appendSystem);
  await writeIfMissing(files.changelog, changelogTemplate);
}
