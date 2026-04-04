/**
 * Tests for session resume detection in index.ts startup logic.
 * Resume is detected via the most recent audit log (system-written by start_research_loop).
 * A missing "## Synthesis Complete" marker means the session was aborted.
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

const COMPLETE_LOG = `# Manager Audit Log

**Task**: AIフレームワーク比較調査
**Started**: 2026-04-04T10:00:00.000Z

---

## Synthesis Complete

**Time**: 2026-04-04T10:30:00.000Z
**WorkUnits synthesized**: 3
**Final Quality Score**: 85/100
**Synthesis Duration**: 30.0s

---
`;

const ABORTED_LOG = `# Manager Audit Log

**Task**: ホームベーカリー調査
**Started**: 2026-04-04T12:48:32.000Z

---

## WorkUnit [1/3] Started

**Time**: 2026-04-04T12:48:45.000Z

## Iteration 1

Iteration timed out.

---
`;

// Inline the detection logic mirroring src/index.ts for testability
async function detectAbortedSession(logsDir: string): Promise<string | undefined> {
  const { readdir, readFile } = await import("node:fs/promises");
  try {
    const logFiles = (await readdir(logsDir))
      .filter((f: string) => f.startsWith("manager-audit-") && f.endsWith(".md"))
      .sort();
    const latestLog = logFiles[logFiles.length - 1];
    if (!latestLog) return undefined;
    const logContent = await readFile(join(logsDir, latestLog), "utf-8");
    const isComplete = logContent.includes("## Synthesis Complete");
    if (isComplete) return undefined;
    const taskMatch = logContent.match(/^\*\*Task\*\*:\s*(.+)$/m);
    const task = taskMatch?.[1]?.trim();
    if (!task) return undefined;
    return `${task}（前回の作業が中断されています。output/ 配下に前回の進捗があります。前回の続きから作業してください）`;
  } catch {
    return undefined;
  }
}

describe("session resume detection via audit log", () => {
  let tempRoot = "";

  before(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "resume-audit-"));
    await mkdir(join(tempRoot, "logs"), { recursive: true });
  });

  after(async () => {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true });
  });

  it("returns undefined when logs dir does not exist", async () => {
    const msg = await detectAbortedSession(join(tempRoot, "nonexistent"));
    assert.equal(msg, undefined);
  });

  it("returns undefined when no audit logs exist", async () => {
    const msg = await detectAbortedSession(join(tempRoot, "logs"));
    assert.equal(msg, undefined);
  });

  it("returns undefined when most recent log has Synthesis Complete", async () => {
    await writeFile(join(tempRoot, "logs", "manager-audit-2026-04-04T10-00-00.md"), COMPLETE_LOG, "utf-8");
    const msg = await detectAbortedSession(join(tempRoot, "logs"));
    assert.equal(msg, undefined);
  });

  it("returns task-based message when most recent log has no Synthesis Complete", async () => {
    await writeFile(join(tempRoot, "logs", "manager-audit-2026-04-04T12-48-32.md"), ABORTED_LOG, "utf-8");
    const msg = await detectAbortedSession(join(tempRoot, "logs"));
    assert.ok(msg !== undefined, "should detect aborted session");
    assert.ok(msg!.startsWith("ホームベーカリー調査"), "message starts with exact task text");
    assert.ok(msg!.includes("中断"), "message mentions interruption");
  });

  it("picks the most recent log (lexicographic sort of ISO timestamps)", async () => {
    // complete log is older (T10), aborted log is newer (T12) — aborted should win
    const msg = await detectAbortedSession(join(tempRoot, "logs"));
    assert.ok(msg !== undefined);
    assert.ok(msg!.startsWith("ホームベーカリー調査"), "picks the newer aborted log");
  });

  it("returns undefined when newest log is complete even if older ones are aborted", async () => {
    // Add an even newer completed log
    await writeFile(
      join(tempRoot, "logs", "manager-audit-2026-04-04T14-00-00.md"),
      COMPLETE_LOG.replace("AIフレームワーク比較調査", "新しいタスク"),
      "utf-8"
    );
    const msg = await detectAbortedSession(join(tempRoot, "logs"));
    assert.equal(msg, undefined, "newest log complete → no resume");
  });
});
