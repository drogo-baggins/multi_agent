import type { Agent } from "@mariozechner/pi-agent-core";
import { invokeAgent } from "../communication/invoke-agent.js";
import {
  createWorkUnit,
  MAX_DECOMPOSITION_DEPTH,
  MAX_WORK_UNITS,
  type WorkUnit
} from "./work-unit.js";

const decompositionPrompt = [
  "Analyze the following task and break it into smaller, independent work units that can each be completed within 8 minutes.",
  "Each work unit should be self-contained and produce concrete findings.",
  "",
  "Respond ONLY with a JSON array. Each element must have:",
  '  { "goal": "what to accomplish", "scope": "what is included", "outOfScope": "what to exclude" }',
  "",
  "Rules:",
  "- 2-8 work units (prefer fewer, larger units)",
  "- Each unit must be independently executable",
  "- Units should cover the full task without gaps or overlaps",
  "- If the task is simple enough for a single unit, return an array with one element",
  "",
  "Task:"
].join("\n");

interface DecomposeOptions {
  invokeAgentFn?: typeof invokeAgent;
}

function extractTextFromResult(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function parseDecompositionResponse(text: string): WorkUnit[] {
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as Array<{ goal: string; scope: string; outOfScope?: string }>;
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.slice(0, MAX_WORK_UNITS).map((item) =>
          createWorkUnit({
            goal: item.goal ?? "",
            scope: item.scope ?? "",
            outOfScope: item.outOfScope
          })
        );
      }
    } catch {
      // Fall through to single-unit fallback
    }
  }

  return [createWorkUnit({ goal: text.slice(0, 500), scope: text.slice(0, 500) })];
}

export async function decomposeTask(
  managerAgent: Agent,
  task: string,
  options?: DecomposeOptions
): Promise<WorkUnit[]> {
  const invoke = options?.invokeAgentFn ?? invokeAgent;
  const prompt = `${decompositionPrompt}\n${task}`;
  const response = await invoke(managerAgent, prompt);
  const text = extractTextFromResult(response);
  return parseDecompositionResponse(text);
}

export function resplitWorkUnit(
  parent: WorkUnit,
  children: Array<{ goal: string; scope: string; outOfScope?: string }>
): WorkUnit[] {
  const childDepth = parent.depth + 1;
  if (childDepth > MAX_DECOMPOSITION_DEPTH) {
    throw new Error(
      `Maximum decomposition depth (${MAX_DECOMPOSITION_DEPTH}) exceeded for work unit "${parent.goal}"`
    );
  }

  return children.slice(0, MAX_WORK_UNITS).map((child) =>
    createWorkUnit({
      goal: child.goal,
      scope: child.scope,
      outOfScope: child.outOfScope,
      depth: childDepth,
      parentId: parent.id
    })
  );
}
