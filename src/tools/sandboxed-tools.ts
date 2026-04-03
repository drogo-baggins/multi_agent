import { mkdirSync, promises as fsPromises } from "node:fs";
import { resolve, isAbsolute, sep } from "node:path";

import type { AgentTool } from "@mariozechner/pi-agent-core";
import {
  createBashTool,
  createReadTool,
  createWriteTool,
  createEditTool,
  createGrepTool,
  createFindTool,
  createLsTool,
} from "@mariozechner/pi-coding-agent";

export function assertWithinSandbox(filePath: string, sandboxDir: string): void {
  if (!isAbsolute(filePath)) return;

  const resolved = resolve(filePath);
  const sandboxResolved = resolve(sandboxDir);

  if (!resolved.startsWith(sandboxResolved + sep) && resolved !== sandboxResolved) {
    throw new Error(
      `Access denied: path "${filePath}" is outside the workspace directory. ` +
        `Use a relative path (e.g. "output/report.md") instead of an absolute path.`
    );
  }
}

export function createSandboxedTools(sandboxDir: string): AgentTool[] {
  mkdirSync(sandboxDir, { recursive: true });

  const readTool = createReadTool(sandboxDir) as unknown as AgentTool;
  const grepTool = createGrepTool(sandboxDir) as unknown as AgentTool;
  const findTool = createFindTool(sandboxDir) as unknown as AgentTool;
  const lsTool = createLsTool(sandboxDir) as unknown as AgentTool;

  const writeTool = createWriteTool(sandboxDir, {
    operations: {
      writeFile: async (absolutePath: string, content: string) => {
        assertWithinSandbox(absolutePath, sandboxDir);
        await fsPromises.writeFile(absolutePath, content, "utf-8");
      },
      mkdir: async (dir: string) => {
        assertWithinSandbox(dir, sandboxDir);
        await fsPromises.mkdir(dir, { recursive: true });
      },
    },
  }) as unknown as AgentTool;

  const editTool = createEditTool(sandboxDir, {
    operations: {
      readFile: async (absolutePath: string) => {
        assertWithinSandbox(absolutePath, sandboxDir);
        return fsPromises.readFile(absolutePath);
      },
      writeFile: async (absolutePath: string, content: string) => {
        assertWithinSandbox(absolutePath, sandboxDir);
        await fsPromises.writeFile(absolutePath, content, "utf-8");
      },
      access: async (absolutePath: string) => {
        assertWithinSandbox(absolutePath, sandboxDir);
        await fsPromises.access(absolutePath);
      },
    },
  }) as unknown as AgentTool;

  const bashTool = createBashTool(sandboxDir) as unknown as AgentTool;

  return [readTool, writeTool, editTool, grepTool, findTool, lsTool, bashTool];
}
