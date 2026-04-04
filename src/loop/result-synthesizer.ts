import type { Agent } from "@mariozechner/pi-agent-core";
import { invokeAgent } from "../communication/invoke-agent.js";
import type { WorkUnitResult } from "./work-unit.js";

export function formatSynthesisPrompt(originalTask: string, results: WorkUnitResult[]): string {
  const findingsBlock = results
    .map((r, i) => [
      `### Finding ${i + 1}: ${r.workUnit.goal}`,
      `Scope: ${r.workUnit.scope}`,
      "",
      r.findings
    ].join("\n"))
    .join("\n\n---\n\n");

  return [
    "Synthesize the following partial research findings into a single, coherent report.",
    "Remove duplicates, ensure logical flow, and maintain all factual content.",
    "The final report should read as if it was written as one piece — not as separate sections stitched together.",
    "",
    `## Original Task`,
    originalTask,
    "",
    `## Partial Findings (${results.length} work units)`,
    "",
    findingsBlock
  ].join("\n");
}

interface SynthesizeOptions {
  invokeAgentFn?: typeof invokeAgent;
  signal?: AbortSignal;
}

function extractText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export async function synthesizeResults(
  managerAgent: Agent,
  originalTask: string,
  results: WorkUnitResult[],
  options?: SynthesizeOptions
): Promise<string> {
  const invoke = options?.invokeAgentFn ?? invokeAgent;
  const prompt = formatSynthesisPrompt(originalTask, results);
  const response = await invoke(managerAgent, prompt, options?.signal);
  return extractText(response);
}
