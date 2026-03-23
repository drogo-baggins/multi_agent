# Task Decomposition Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Manager agent autonomously decomposes large tasks into time-bounded WorkUnits, dispatches them to Worker sequentially, and synthesizes results — so users never encounter timeout failures or need to manually split tasks.

**Architecture:** A new `task-decomposer.ts` module sits between the `start_research_loop` tool and `runPersistenceLoop`. Manager analyzes the task, produces a backlog of WorkUnits, and an orchestrator runs each WorkUnit through the existing persistence loop. On timeout, the failed WorkUnit is re-split. After all WorkUnits complete, Manager synthesizes findings into a final work product. The existing persistence loop is NOT modified — decomposition wraps around it.

**Tech Stack:** TypeScript, Node.js, existing PI agent framework, existing persistence loop, existing audit logger.

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/loop/work-unit.ts` (CREATE) | `WorkUnit` type, `WorkUnitResult` type, `DecompositionPlan` type, backlog state management |
| `src/loop/task-decomposer.ts` (CREATE) | Manager-driven task analysis → WorkUnit backlog generation, reactive re-splitting on timeout |
| `src/loop/task-orchestrator.ts` (CREATE) | Runs WorkUnits sequentially through existing persistence loop, collects results, triggers synthesis |
| `src/loop/result-synthesizer.ts` (CREATE) | Manager-driven final synthesis of all WorkUnit findings into unified work product |
| `src/loop/manager-audit-log.ts` (MODIFY) | Add `logDecomposition()`, `logWorkUnitStart()`, `logWorkUnitComplete()`, `logSynthesis()` methods to `AuditLogger` |
| `src/loop/loop-integration.ts` (MODIFY) | Add `onWorkUnitProgress` callback to `LoopIntegrationOptions` for progress notifications |
| `src/tools/tool-definitions.ts` (MODIFY) | Replace direct `runPersistenceLoop` call with `runDecomposedLoop` in `start_research_loop` tool |
| `src/loop/index.ts` (MODIFY) | Add exports for new modules |
| Test files (CREATE) | `work-unit.test.ts`, `task-decomposer.test.ts`, `task-orchestrator.test.ts`, `result-synthesizer.test.ts` |

---

## Chunk 1: WorkUnit Type System

### Task 1: Define core types (work-unit.ts)

**Files:**
- Create: `src/loop/work-unit.ts`
- Test: `src/loop/work-unit.test.ts`
- Modify: `src/loop/index.ts`

**Design decisions:**
- `WorkUnit` is a plain data object — no behavior, just boundaries.
- `DecompositionPlan` holds the full backlog + metadata for audit trail.
- `WorkUnitResult` wraps the persistence loop's `IterationResult[]` with WorkUnit identity.
- Safety limits: `MAX_DECOMPOSITION_DEPTH = 3`, `MAX_WORK_UNITS = 20`, `MAX_RETRIES_PER_UNIT = 2`.

- [ ] **Step 1: Write the failing test for WorkUnit creation helper**

```typescript
// src/loop/work-unit.test.ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorkUnit, createDecompositionPlan, type WorkUnit } from "./work-unit.js";

describe("createWorkUnit", () => {
  it("creates a work unit with required fields", () => {
    const unit = createWorkUnit({
      goal: "Investigate MDM vendor landscape",
      scope: "List top 5 MDM vendors with market share",
      outOfScope: "Detailed pricing analysis"
    });

    assert.equal(unit.goal, "Investigate MDM vendor landscape");
    assert.equal(unit.scope, "List top 5 MDM vendors with market share");
    assert.equal(unit.outOfScope, "Detailed pricing analysis");
    assert.equal(unit.status, "pending");
    assert.equal(unit.depth, 0);
    assert.ok(unit.id.length > 0);
  });

  it("assigns unique IDs", () => {
    const a = createWorkUnit({ goal: "A", scope: "A" });
    const b = createWorkUnit({ goal: "B", scope: "B" });
    assert.notEqual(a.id, b.id);
  });
});

describe("createDecompositionPlan", () => {
  it("creates plan with metadata", () => {
    const units: WorkUnit[] = [
      createWorkUnit({ goal: "A", scope: "A" }),
      createWorkUnit({ goal: "B", scope: "B" })
    ];
    const plan = createDecompositionPlan("Research MDM tools", units);

    assert.equal(plan.originalTask, "Research MDM tools");
    assert.equal(plan.workUnits.length, 2);
    assert.ok(plan.createdAt.length > 0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/loop/work-unit.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/loop/work-unit.ts
import { randomUUID } from "node:crypto";

export const MAX_DECOMPOSITION_DEPTH = 3;
export const MAX_WORK_UNITS = 20;
export const MAX_RETRIES_PER_UNIT = 2;

export type WorkUnitStatus = "pending" | "in-progress" | "complete" | "partial" | "timeout" | "failed";

export interface WorkUnit {
  id: string;
  goal: string;
  scope: string;
  outOfScope: string;
  status: WorkUnitStatus;
  depth: number;
  parentId: string | null;
  retryCount: number;
}

export interface WorkUnitResult {
  workUnit: WorkUnit;
  findings: string;
  remainingWork: string[];
  durationMs: number;
}

export interface DecompositionPlan {
  originalTask: string;
  workUnits: WorkUnit[];
  createdAt: string;
}

export function createWorkUnit(params: {
  goal: string;
  scope: string;
  outOfScope?: string;
  depth?: number;
  parentId?: string;
}): WorkUnit {
  return {
    id: randomUUID().slice(0, 8),
    goal: params.goal,
    scope: params.scope,
    outOfScope: params.outOfScope ?? "",
    status: "pending",
    depth: params.depth ?? 0,
    parentId: params.parentId ?? null,
    retryCount: 0
  };
}

export function createDecompositionPlan(originalTask: string, workUnits: WorkUnit[]): DecompositionPlan {
  return {
    originalTask,
    workUnits,
    createdAt: new Date().toISOString()
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/loop/work-unit.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Add export to index.ts**

Add `export * from "./work-unit.js";` to `src/loop/index.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/loop/work-unit.ts src/loop/work-unit.test.ts src/loop/index.ts
git commit -m "feat: add WorkUnit type system with safety limits"
```

---

## Chunk 2: Task Decomposer (Manager → WorkUnits)

### Task 2: Manager-driven task decomposition

**Files:**
- Create: `src/loop/task-decomposer.ts`
- Test: `src/loop/task-decomposer.test.ts`

**Design decisions:**
- Decomposer invokes Manager agent with a structured prompt asking for JSON-formatted WorkUnit list.
- Response is parsed with fallback: if JSON parse fails, treat entire task as single WorkUnit (graceful degradation).
- Re-splitting (on timeout) creates child WorkUnits with `depth + 1` and `parentId` set to failed unit.
- `MAX_DECOMPOSITION_DEPTH` enforced: at max depth, timeout is terminal (escalate to user).
- `MAX_WORK_UNITS` enforced: if decomposition produces too many units, truncate and warn.

- [ ] **Step 1: Write failing tests**

```typescript
// src/loop/task-decomposer.test.ts
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { decomposeTask, resplitWorkUnit, parseDecompositionResponse } from "./task-decomposer.js";
import type { WorkUnit } from "./work-unit.js";
import { MAX_DECOMPOSITION_DEPTH, MAX_WORK_UNITS } from "./work-unit.js";

describe("parseDecompositionResponse", () => {
  it("parses valid JSON array of work units", () => {
    const response = JSON.stringify([
      { goal: "Survey vendors", scope: "Top 5 MDM vendors" },
      { goal: "Compare features", scope: "Feature matrix" }
    ]);
    const units = parseDecompositionResponse(response);
    assert.equal(units.length, 2);
    assert.equal(units[0]!.goal, "Survey vendors");
  });

  it("returns single unit for unparseable response", () => {
    const units = parseDecompositionResponse("Just do the whole research");
    assert.equal(units.length, 1);
    assert.equal(units[0]!.goal, "Just do the whole research");
  });

  it("caps at MAX_WORK_UNITS", () => {
    const items = Array.from({ length: 30 }, (_, i) => ({ goal: `Unit ${i}`, scope: `Scope ${i}` }));
    const units = parseDecompositionResponse(JSON.stringify(items));
    assert.equal(units.length, MAX_WORK_UNITS);
  });
});

describe("resplitWorkUnit", () => {
  it("creates child units with incremented depth", () => {
    const parent: WorkUnit = {
      id: "abc",
      goal: "Security evaluation",
      scope: "All aspects",
      outOfScope: "",
      status: "timeout",
      depth: 0,
      parentId: null,
      retryCount: 0
    };
    const children = [
      { goal: "Auth analysis", scope: "Authentication mechanisms" },
      { goal: "Encryption analysis", scope: "Data encryption" }
    ];
    const result = resplitWorkUnit(parent, children);
    assert.equal(result.length, 2);
    assert.equal(result[0]!.depth, 1);
    assert.equal(result[0]!.parentId, "abc");
  });

  it("throws when max depth exceeded", () => {
    const parent: WorkUnit = {
      id: "abc",
      goal: "Deep task",
      scope: "scope",
      outOfScope: "",
      status: "timeout",
      depth: MAX_DECOMPOSITION_DEPTH,
      parentId: null,
      retryCount: 0
    };
    assert.throws(
      () => resplitWorkUnit(parent, [{ goal: "child", scope: "child" }]),
      /maximum decomposition depth/i
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/loop/task-decomposer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/loop/task-decomposer.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/loop/task-decomposer.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/loop/task-decomposer.ts src/loop/task-decomposer.test.ts
git commit -m "feat: add task decomposer with Manager-driven analysis and resplit"
```

---

## Chunk 3: Result Synthesizer

### Task 3: Manager-driven synthesis of WorkUnit findings

**Files:**
- Create: `src/loop/result-synthesizer.ts`
- Test: `src/loop/result-synthesizer.test.ts`

**Design decisions:**
- Synthesizer invokes Manager with all WorkUnit findings + original task → Manager produces unified work product.
- Input is structured: each finding tagged with its WorkUnit goal so Manager knows the source.
- Output is plain string (the final work product text).

- [ ] **Step 1: Write failing tests**

```typescript
// src/loop/result-synthesizer.test.ts
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import { formatSynthesisPrompt, synthesizeResults } from "./result-synthesizer.js";
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/loop/result-synthesizer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write implementation**

```typescript
// src/loop/result-synthesizer.ts
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
  const response = await invoke(managerAgent, prompt);
  return extractText(response);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/loop/result-synthesizer.test.ts`
Expected: PASS (1 test)

- [ ] **Step 5: Commit**

```bash
git add src/loop/result-synthesizer.ts src/loop/result-synthesizer.test.ts
git commit -m "feat: add result synthesizer for merging WorkUnit findings"
```

---

## Chunk 4: Audit Log Extension

### Task 4: Extend audit logger with decomposition events

**Files:**
- Modify: `src/loop/manager-audit-log.ts`
- Modify: `src/loop/manager-audit-log.test.ts`

**Design decisions:**
- `AuditLogger` interface gets new methods: `logDecomposition()`, `logWorkUnitStart()`, `logWorkUnitComplete()`, `logResplit()`, `logSynthesis()`.
- All methods append to the SAME markdown file (one audit trail per research session).
- Format follows existing Markdown style with `##` / `###` headings.

- [ ] **Step 1: Write failing tests for new audit methods**

```typescript
// Add to src/loop/manager-audit-log.test.ts

// -- New imports at top --
import type { DecompositionPlan, WorkUnit, WorkUnitResult } from "./work-unit.js";
import { createWorkUnit, createDecompositionPlan } from "./work-unit.js";

describe("audit log decomposition events", () => {
  it("logs decomposition plan with all work units", async () => {
    const dir = makeTempDir();
    const logger = await createAuditLogger(dir, "Research MDM");

    const units = [
      createWorkUnit({ goal: "Survey vendors", scope: "Top 5" }),
      createWorkUnit({ goal: "Compare features", scope: "Matrix" })
    ];
    const plan = createDecompositionPlan("Research MDM", units);
    await logger.logDecomposition(plan);

    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    const content = await readFile(join(dir, files[0]!), "utf-8");
    assert.equal(content.includes("## Task Decomposition"), true);
    assert.equal(content.includes("Survey vendors"), true);
    assert.equal(content.includes("Compare features"), true);
    assert.equal(content.includes("2 WorkUnits"), true);
  });

  it("logs work unit start", async () => {
    const dir = makeTempDir();
    const logger = await createAuditLogger(dir, "Task");
    const unit = createWorkUnit({ goal: "Test unit", scope: "scope" });
    await logger.logWorkUnitStart(unit, 1, 3);

    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    const content = await readFile(join(dir, files[0]!), "utf-8");
    assert.equal(content.includes("[1/3]"), true);
    assert.equal(content.includes("Test unit"), true);
  });

  it("logs work unit completion with duration", async () => {
    const dir = makeTempDir();
    const logger = await createAuditLogger(dir, "Task");
    const unit = createWorkUnit({ goal: "Done unit", scope: "scope" });
    const result: WorkUnitResult = {
      workUnit: unit,
      findings: "Found things",
      remainingWork: [],
      durationMs: 45000
    };
    await logger.logWorkUnitComplete(result, 72);

    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    const content = await readFile(join(dir, files[0]!), "utf-8");
    assert.equal(content.includes("Done unit"), true);
    assert.equal(content.includes("45.0s"), true);
    assert.equal(content.includes("72/100"), true);
  });

  it("logs synthesis completion", async () => {
    const dir = makeTempDir();
    const logger = await createAuditLogger(dir, "Task");
    await logger.logSynthesis(3, 82, 12000);

    const files = await import("node:fs/promises").then((fs) => fs.readdir(dir));
    const content = await readFile(join(dir, files[0]!), "utf-8");
    assert.equal(content.includes("Synthesis"), true);
    assert.equal(content.includes("3"), true);
    assert.equal(content.includes("82/100"), true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/loop/manager-audit-log.test.ts`
Expected: FAIL — logDecomposition is not a function

- [ ] **Step 3: Extend AuditLogger interface and implementation**

Extend the `AuditLogger` interface in `manager-audit-log.ts`:

```typescript
export interface AuditLogger {
  logIteration(result: IterationResult): Promise<void>;
  logDecomposition(plan: DecompositionPlan): Promise<void>;
  logWorkUnitStart(unit: WorkUnit, index: number, total: number): Promise<void>;
  logWorkUnitComplete(result: WorkUnitResult, qualityScore: number): Promise<void>;
  logResplit(parent: WorkUnit, children: WorkUnit[], reason: string): Promise<void>;
  logSynthesis(unitCount: number, finalScore: number, durationMs: number): Promise<void>;
}
```

Add import for `DecompositionPlan`, `WorkUnit`, `WorkUnitResult` from `./work-unit.js`.

Add formatting functions and extend `createAuditLogger` return object with the new methods. Each method calls `ensureHeader()` then `appendFile()` with formatted Markdown.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/loop/manager-audit-log.test.ts`
Expected: PASS (all existing + 4 new tests)

- [ ] **Step 5: Commit**

```bash
git add src/loop/manager-audit-log.ts src/loop/manager-audit-log.test.ts
git commit -m "feat: extend audit logger with decomposition, progress, and synthesis events"
```

---

## Chunk 5: Task Orchestrator

### Task 5: Orchestrate WorkUnit execution through existing persistence loop

**Files:**
- Create: `src/loop/task-orchestrator.ts`
- Test: `src/loop/task-orchestrator.test.ts`
- Modify: `src/loop/index.ts`

**Design decisions:**
- Orchestrator is the main entry point replacing direct `runPersistenceLoop` calls for decomposed tasks.
- Sequence: `decomposeTask → for each WorkUnit: runPersistenceLoop → on timeout: resplit → synthesizeResults`.
- Each WorkUnit runs as a fresh persistence loop with `maxIterations: 3` (fewer iterations per unit since scope is smaller).
- Progress notifications via `ui.notify()` at WorkUnit start/complete.
- Latency prediction: if average Worker execution time from previous WorkUnits exceeds 70% of `iterationTimeoutMs`, warn in audit log (actual preemptive splitting deferred to future iteration).
- Single-unit optimization: if Manager decomposes into 1 unit, skip orchestration and run original persistence loop directly.

- [ ] **Step 1: Write failing tests**

```typescript
// src/loop/task-orchestrator.test.ts
import assert from "node:assert/strict";
import { describe, it, mock, afterEach } from "node:test";
import { runDecomposedLoop, type DecomposedLoopOptions } from "./task-orchestrator.js";

// Test: Single-unit passthrough (no decomposition overhead)
// Test: Multi-unit sequential execution
// Test: Timeout triggers resplit
// Test: Max depth exceeded escalates to user
// Test: Progress notifications sent at unit boundaries
// Test: Synthesis called with all findings
// Test: Audit logger called at each phase

// (Full test implementations follow the patterns in persistence-loop.test.ts
//  and loop-integration.test.ts — mock the callbacks, verify call sequences)
```

- [ ] **Step 2-5: Implement, test, commit**

Implementation creates `runDecomposedLoop()` function that:
1. Calls `decomposeTask()` to get WorkUnits
2. Logs decomposition plan to audit
3. For each WorkUnit:
   a. Set status to "in-progress", notify user `[N/M] goal`
   b. Log WorkUnit start to audit
   c. Run `runPersistenceLoop()` with WorkUnit.goal as task
   d. If timeout: attempt `resplitWorkUnit()` (if depth allows), log resplit, add children to backlog
   e. If complete: collect findings, log WorkUnit complete to audit
   f. Notify user `[N/M] goal complete (score/100, duration)`
4. Call `synthesizeResults()` with all findings
5. Log synthesis to audit
6. Return final synthesized work product

```bash
git add src/loop/task-orchestrator.ts src/loop/task-orchestrator.test.ts src/loop/index.ts
git commit -m "feat: add task orchestrator for decomposed loop execution"
```

---

## Chunk 6: Integration Wiring

### Task 6: Wire orchestrator into start_research_loop tool

**Files:**
- Modify: `src/tools/tool-definitions.ts`
- Modify: `src/loop/loop-integration.ts`
- Modify: `src/index.ts`

**Design decisions:**
- `start_research_loop` tool calls `runDecomposedLoop()` instead of `runPersistenceLoop()` directly.
- If decomposition produces 1 unit, falls through to existing behavior (zero overhead for simple tasks).
- Progress reports include WorkUnit context: `WorkUnit 1/4 "Survey vendors" | Score: 78/100 | 192s`.
- `LoopIntegrationOptions` gets an optional `onWorkUnitProgress` callback for structured progress data.

- [ ] **Step 1: Update tool-definitions.ts**

Replace the `runPersistenceLoop` call in `createStartResearchLoopToolDefinition` with `runDecomposedLoop`. Pass registry (for Manager agent access), UI, logsDir, and callbacks.

- [ ] **Step 2: Update loop-integration.ts**

Add `onWorkUnitProgress?: (unitIndex: number, total: number, goal: string, status: string) => void` to `LoopIntegrationOptions`.

- [ ] **Step 3: Run all tests**

Run: `npx tsx --test src/**/*.test.ts`
Expected: ALL PASS (existing tests should not break since single-unit optimization preserves original behavior)

- [ ] **Step 4: Commit**

```bash
git add src/tools/tool-definitions.ts src/loop/loop-integration.ts src/index.ts
git commit -m "feat: wire task orchestrator into start_research_loop tool"
```

---

## Verification Checklist

After all chunks:
- [ ] `npx tsx --test src/**/*.test.ts` — ALL PASS
- [ ] LSP diagnostics clean on all modified/created files
- [ ] Single-unit tasks behave identically to before (regression check)
- [ ] Audit log file contains decomposition plan, per-WorkUnit entries, and synthesis record
- [ ] Progress notifications (`ui.notify`) fire at WorkUnit boundaries
- [ ] Timeout on a WorkUnit triggers resplit (not loop exit)
- [ ] Max depth exceeded produces clear error to user (not infinite loop)
