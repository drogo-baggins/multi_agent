import { mkdirSync } from "node:fs";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import { createBashTool, createCodingTools } from "@mariozechner/pi-coding-agent";

export function createSandboxedTools(sandboxDir: string): AgentTool[] {
  mkdirSync(sandboxDir, { recursive: true });

  const codingTools = createCodingTools(sandboxDir) as AgentTool[];
  const bashTool = createBashTool(sandboxDir) as unknown as AgentTool;

  return [...codingTools.filter((tool) => tool.name !== "bash"), bashTool];
}
