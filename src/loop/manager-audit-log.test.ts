import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, it } from "node:test";

import type { IterationResult } from "./persistence-loop.js";
import { formatAuditEntry, createAuditLogger } from "./manager-audit-log.js";

function createIterationResult(overrides?: Partial<IterationResult>): IterationResult {
  return {
    iteration: 1,
    workProduct: "placeholder work product",
    evaluation: {
      qualityScore: 72,
      summary: "Decent output with room for improvement.",
      issues: [
        {
          category: "coverage",
          description: "Missing security section",
          evidence: "No mention of authentication",
          cause: "config"
        },
        {
          category: "accuracy",
          description: "Outdated version reference",
          evidence: "References v1.0 but current is v2.0",
          cause: "task-difficulty"
        }
      ]
    },
    improvements: ["Add security analysis section", "Update version references to v2.0"],
    latencyMs: {
      workerExecutionMs: 45000,
      evaluationMs: 12000,
      managerImprovementMs: 8000,
      totalMs: 71000
    },
    outcome: "improvement-applied",
    ...overrides
  };
}

let tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = join(tmpdir(), `audit-log-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe("formatAuditEntry", () => {
  it("includes iteration number, score, outcome, and summary", () => {
    const result = createIterationResult();
    const entry = formatAuditEntry(result, new Date("2026-03-23T10:00:00Z"));

    assert.equal(entry.includes("## Iteration 1"), true);
    assert.equal(entry.includes("72/100"), true);
    assert.equal(entry.includes("improvement-applied"), true);
    assert.equal(entry.includes("Decent output with room for improvement."), true);
  });

  it("lists all issues with category, description, evidence, and cause", () => {
    const result = createIterationResult();
    const entry = formatAuditEntry(result, new Date());

    assert.equal(entry.includes("[coverage]"), true);
    assert.equal(entry.includes("Missing security section"), true);
    assert.equal(entry.includes("No mention of authentication"), true);
    assert.equal(entry.includes("config"), true);
    assert.equal(entry.includes("[accuracy]"), true);
    assert.equal(entry.includes("Outdated version reference"), true);
  });

  it("lists all improvement instructions", () => {
    const result = createIterationResult();
    const entry = formatAuditEntry(result, new Date());

    assert.equal(entry.includes("Add security analysis section"), true);
    assert.equal(entry.includes("Update version references to v2.0"), true);
  });

  it("includes latency table with all phases", () => {
    const result = createIterationResult();
    const entry = formatAuditEntry(result, new Date());

    assert.equal(entry.includes("45.0s"), true);
    assert.equal(entry.includes("12.0s"), true);
    assert.equal(entry.includes("8.0s"), true);
    assert.equal(entry.includes("71.0s"), true);
  });

  it("handles zero issues", () => {
    const result = createIterationResult({
      evaluation: { qualityScore: 95, summary: "Excellent.", issues: [] }
    });
    const entry = formatAuditEntry(result, new Date());

    assert.equal(entry.includes("Issues Detected"), true);
    assert.equal(entry.includes("None"), true);
  });

  it("handles zero improvements", () => {
    const result = createIterationResult({
      improvements: [],
      outcome: "user-approved"
    });
    const entry = formatAuditEntry(result, new Date());

    assert.equal(entry.includes("Improvement Instructions"), true);
    assert.equal(entry.includes("None (no improvement cycle)"), true);
  });

  it("formats millisecond-level durations as ms", () => {
    const result = createIterationResult({
      latencyMs: {
        workerExecutionMs: 500,
        evaluationMs: 200,
        managerImprovementMs: 100,
        totalMs: 900
      }
    });
    const entry = formatAuditEntry(result, new Date());

    assert.equal(entry.includes("500ms"), true);
    assert.equal(entry.includes("200ms"), true);
    assert.equal(entry.includes("100ms"), true);
    assert.equal(entry.includes("900ms"), true);
  });
});

describe("createAuditLogger", () => {
  it("creates log file with header on first logIteration call", async () => {
    const dir = makeTempDir();
    const logger = await createAuditLogger(dir, "Research MDM tools");

    await logger.logIteration(createIterationResult());

    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    assert.equal(files.length, 1);
    assert.equal(files[0]!.startsWith("manager-audit-"), true);
    assert.equal(files[0]!.endsWith(".md"), true);

    const content = await readFile(join(dir, files[0]!), "utf-8");
    assert.equal(content.includes("# Manager Audit Log"), true);
    assert.equal(content.includes("Research MDM tools"), true);
    assert.equal(content.includes("## Iteration 1"), true);
  });

  it("appends multiple iterations to the same file", async () => {
    const dir = makeTempDir();
    const logger = await createAuditLogger(dir, "Multi-iteration task");

    await logger.logIteration(createIterationResult({ iteration: 1 }));
    await logger.logIteration(createIterationResult({
      iteration: 2,
      evaluation: { qualityScore: 88, summary: "Much improved.", issues: [] },
      improvements: [],
      outcome: "user-approved"
    }));

    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    assert.equal(files.length, 1);

    const content = await readFile(join(dir, files[0]!), "utf-8");
    assert.equal(content.includes("## Iteration 1"), true);
    assert.equal(content.includes("## Iteration 2"), true);
    assert.equal(content.includes("72/100"), true);
    assert.equal(content.includes("88/100"), true);
  });

  it("creates logs directory if it does not exist", async () => {
    const dir = join(makeTempDir(), "nested", "deep");
    const logger = await createAuditLogger(dir, "Nested dir task");

    await logger.logIteration(createIterationResult());

    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    assert.equal(files.length, 1);
  });
});
