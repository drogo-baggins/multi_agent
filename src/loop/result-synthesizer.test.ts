import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatSynthesisPrompt } from "./result-synthesizer.js";
import type { WorkUnitResult } from "./work-unit.js";
import { createWorkUnit } from "./work-unit.js";

describe("formatSynthesisPrompt", () => {
  it("includes original task and all findings with work unit labels", () => {
    const results: WorkUnitResult[] = [
      {
        workUnit: createWorkUnit({ goal: "Survey vendors", scope: "Top 5" }),
        findings: "Jamf, Intune, VMware...",
        remainingWork: [],
        durationMs: 180000
      },
      {
        workUnit: createWorkUnit({ goal: "Compare features", scope: "Feature matrix" }),
        findings: "Jamf excels at Apple...",
        remainingWork: [],
        durationMs: 240000
      }
    ];

    const prompt = formatSynthesisPrompt("Research MDM tools", results);
    assert.equal(prompt.includes("Research MDM tools"), true);
    assert.equal(prompt.includes("Survey vendors"), true);
    assert.equal(prompt.includes("Jamf, Intune, VMware..."), true);
    assert.equal(prompt.includes("Compare features"), true);
    assert.equal(prompt.includes("Jamf excels at Apple..."), true);
  });

  it("includes section headers and separators", () => {
    const results: WorkUnitResult[] = [
      {
        workUnit: createWorkUnit({ goal: "Part A", scope: "A" }),
        findings: "Finding A",
        remainingWork: [],
        durationMs: 100000
      }
    ];

    const prompt = formatSynthesisPrompt("Task", results);
    assert.equal(prompt.includes("Original Task"), true);
    assert.equal(prompt.includes("Partial Findings"), true);
    assert.equal(prompt.includes("Finding 1"), true);
  });

  it("handles empty results array", () => {
    const prompt = formatSynthesisPrompt("Empty task", []);
    assert.equal(prompt.includes("Empty task"), true);
    assert.equal(prompt.includes("0 work units"), true);
  });
});
