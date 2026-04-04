# Loop Status Bar Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the current loop phase (Worker running / Manager evaluating / Awaiting feedback / Manager improving), iteration number, and score in the TUI footer during `start_research_loop` execution.

**Architecture:** Add an optional `LoopStatusReporter` interface to `loop-integration.ts` that fires per-phase callbacks. Wire it to `ctx.ui.setStatus()` / `ctx.ui.setWorkingMessage()` inside the `start_research_loop` tool execute function, guarded by `ctx.hasUI`. Existing tests and callers are unaffected because `statusReporter` is optional.

**Tech Stack:** TypeScript, Node.js built-in test runner (`node:test`), `@mariozechner/pi-coding-agent` `ExtensionContext` (`ctx.ui.setStatus`, `ctx.ui.setWorkingMessage`)

---

## Task 1: Add `LoopStatusReporter` to `loop-integration.ts`

**Files:**
- Modify: `src/loop/loop-integration.ts`
- Modify: `src/loop/loop-integration.test.ts`

### What to add

Add the following **before** `LoopIntegrationOptions`:

```typescript
export interface LoopStatusReporter {
  onWorkerStart(iteration: number, maxIterations: number): void;
  onEvaluationStart(iteration: number, maxIterations: number): void;
  onFeedbackWaiting(iteration: number, maxIterations: number, score: number): void;
  onImprovementStart(iteration: number, maxIterations: number): void;
  onLoopComplete(totalIterations: number, finalScore: number): void;
  onLoopInterrupted(iteration: number): void;
}
```

Add two optional fields to `LoopIntegrationOptions`:

```typescript
maxIterations?: number;        // used for display only, default 10
statusReporter?: LoopStatusReporter;
```

In `createLoopCallbacks`, call the reporter at the start of the relevant callbacks:

```typescript
// Inside executeWorker (before invokeAgent call):
options.statusReporter?.onWorkerStart(context.iteration, options.maxIterations ?? 10);

// Inside evaluateProduct (before invokeAgent call):
// evaluateProduct doesn't receive iteration; track it separately.
// Use a closure variable `let currentIteration = 1` in createLoopCallbacks.
// Increment it in onIterationComplete.
options.statusReporter?.onEvaluationStart(currentIteration, options.maxIterations ?? 10);

// Inside getUserFeedback (after deciding NOT auto-approved and NOT auto-improve):
// i.e., when about to call ui.select / when qualityThreshold is undefined:
options.statusReporter?.onFeedbackWaiting(iteration, options.maxIterations ?? 10, evaluation.qualityScore);

// Inside executeImprovement (before invokeAgent call):
options.statusReporter?.onImprovementStart(currentIteration, options.maxIterations ?? 10);

// Inside onIterationComplete:
// Already called at end of each iteration. Call reporter based on outcome:
// if outcome is "approved" or "max-iterations-reached": call onLoopComplete
// if outcome is "interrupted": call onLoopInterrupted
// Otherwise: increment currentIteration (next iteration starts)
```

**Tracking iteration number in evaluateProduct / executeImprovement:**

`evaluateProduct` and `executeImprovement` do not receive an iteration number. Use a closure variable:

```typescript
export function createLoopCallbacks(options: LoopIntegrationOptions): LoopCallbacks {
  let currentIteration = 1;
  // ...
```

Increment `currentIteration` in `onIterationComplete` only when the outcome is NOT terminal:

```typescript
onIterationComplete: (result: IterationResult): void => {
  if (result.outcome === "approved" || result.outcome === "max-iterations-reached") {
    options.statusReporter?.onLoopComplete(result.iteration, result.evaluation.qualityScore);
  } else if (result.outcome === "interrupted") {
    options.statusReporter?.onLoopInterrupted(result.iteration);
  } else {
    currentIteration = result.iteration + 1;
  }
  options.onIterationReport?.(formatIterationReport(result));
  void getAuditLogger().then((logger) => logger?.logIteration(result));
},
```

**What IterationResult.outcome values exist?**

Check `src/loop/persistence-loop.ts` for the `outcome` field type. The values are likely: `"approved"`, `"improvement-applied"`, `"interrupted"`, `"max-iterations-reached"`. Confirm before coding.

### Steps

- [ ] **Step 1: Read `src/loop/persistence-loop.ts`**

  Open the file and find the `IterationResult` type, specifically `outcome` field values. Note all possible values.

- [ ] **Step 2: Write the failing tests**

  In `src/loop/loop-integration.test.ts`, add a new `describe("LoopStatusReporter integration", ...)` block **after** the existing `describe("autonomous mode (qualityThreshold)", ...)` block.

  Write 6 tests:

  ```typescript
  describe("LoopStatusReporter integration", () => {
    it("calls onWorkerStart with iteration and maxIterations when executeWorker is called", async () => {
      // Create statusReporter mock with mock.fn() for each method
      // Create callbacks with statusReporter and maxIterations: 5
      // Call executeWorker("task", { iteration: 2 })
      // Assert onWorkerStart called with (2, 5)
      // Assert other reporter methods NOT called
    });

    it("calls onEvaluationStart with currentIteration when evaluateProduct is called", async () => {
      // Create callbacks with maxIterations: 7
      // Call evaluateProduct("product")
      // Assert onEvaluationStart called with (1, 7) (iteration starts at 1)
    });

    it("calls onFeedbackWaiting with score when getUserFeedback is called (interactive mode)", async () => {
      // Create callbacks WITHOUT qualityThreshold
      // Call getUserFeedback("product", evaluation(score=72), 3)
      // Assert onFeedbackWaiting called with (3, 10, 72) (default maxIterations=10)
    });

    it("does NOT call onFeedbackWaiting in autonomous mode (qualityThreshold set)", async () => {
      // Create callbacks WITH qualityThreshold: 80
      // Call getUserFeedback with score=50 (below threshold, triggers improve)
      // Assert onFeedbackWaiting NOT called
    });

    it("calls onImprovementStart when executeImprovement is called", async () => {
      // Create callbacks
      // Call executeImprovement([...])
      // Assert onImprovementStart called with (1, 10)
    });

    it("calls onLoopComplete on approved outcome and onLoopInterrupted on interrupted outcome", () => {
      // Call onIterationComplete with outcome="approved", score=90
      // Assert onLoopComplete called with (iteration, 90)
      // Call onIterationComplete with outcome="interrupted"
      // Assert onLoopInterrupted called with (iteration)
    });
  });
  ```

- [ ] **Step 3: Run tests to verify they fail**

  Run: `npm test -- --test-name-pattern "LoopStatusReporter integration"` (from worktree dir)
  Expected: FAIL (LoopStatusReporter does not exist yet)

- [ ] **Step 4: Add `LoopStatusReporter` interface and `maxIterations`/`statusReporter` fields**

  In `src/loop/loop-integration.ts`:
  - Add `LoopStatusReporter` export interface before `LoopIntegrationOptions`
  - Add `maxIterations?: number` and `statusReporter?: LoopStatusReporter` to `LoopIntegrationOptions`

- [ ] **Step 5: Add closure variable and reporter calls in `createLoopCallbacks`**

  - Add `let currentIteration = 1;` at the top of the function body
  - Add reporter calls in each callback (executeWorker, evaluateProduct, getUserFeedback, executeImprovement, onIterationComplete) as described above

- [ ] **Step 6: Run ALL tests to verify they pass**

  Run: `npm test`
  Expected: all pass (146 + 6 new = 152)

- [ ] **Step 7: Commit**

  ```bash
  git add src/loop/loop-integration.ts src/loop/loop-integration.test.ts
  git commit -m "feat(loop): add LoopStatusReporter interface for phase-level status callbacks"
  ```

---

## Task 2: Wire `LoopStatusReporter` to `ctx.ui.setStatus` in `start_research_loop`

**Files:**
- Modify: `src/tools/tool-definitions.ts`

### What to add

Inside the `execute` function of `createStartResearchLoopToolDefinition`, after the `ui` object is built and before `createLoopCallbacks`:

```typescript
const STATUS_KEY = "loop";
const maxIterations = params.maxIterations ?? 10;

const statusReporter: LoopStatusReporter | undefined = ctx.hasUI
  ? {
      onWorkerStart(iteration, max) {
        ctx.ui.setStatus(STATUS_KEY, `Iter ${iteration}/${max} — Worker running...`);
        ctx.ui.setWorkingMessage(`Research loop Iter ${iteration}/${max}: Worker running`);
      },
      onEvaluationStart(iteration, max) {
        ctx.ui.setStatus(STATUS_KEY, `Iter ${iteration}/${max} — Manager evaluating...`);
        ctx.ui.setWorkingMessage(`Research loop Iter ${iteration}/${max}: Manager evaluating`);
      },
      onFeedbackWaiting(iteration, max, score) {
        ctx.ui.setStatus(STATUS_KEY, `Iter ${iteration}/${max} — Score: ${score}/100 — Awaiting feedback`);
        ctx.ui.setWorkingMessage();
      },
      onImprovementStart(iteration, max) {
        ctx.ui.setStatus(STATUS_KEY, `Iter ${iteration}/${max} — Manager improving...`);
        ctx.ui.setWorkingMessage(`Research loop Iter ${iteration}/${max}: Manager improving`);
      },
      onLoopComplete(totalIterations, finalScore) {
        ctx.ui.setStatus(STATUS_KEY, `Complete — ${totalIterations} iter, final score: ${finalScore}/100`);
        ctx.ui.setWorkingMessage();
      },
      onLoopInterrupted(iteration) {
        ctx.ui.setStatus(STATUS_KEY, `Interrupted — at iter ${iteration}`);
        ctx.ui.setWorkingMessage();
      },
    }
  : undefined;
```

Then pass `maxIterations` and `statusReporter` to `createLoopCallbacks`:

```typescript
const callbacks = createLoopCallbacks({
  registry,
  workerConfigDir,
  ui,
  logsDir,
  task: params.task,
  qualityThreshold: params.qualityThreshold,
  auditLogger,
  maxIterations,        // add
  statusReporter,       // add
  onIterationReport: (report) => {
    iterationReports.push(report);
  }
});
```

Also add to imports at the top of the file:

```typescript
import { createLoopCallbacks, type UserInteraction, type LoopStatusReporter } from "../loop/loop-integration.js";
```

**Status cleanup:** After `runDecomposedLoop` resolves (both success and error paths), clear the status:

```typescript
// In the finally block, or at the end of both try/catch branches:
if (ctx.hasUI) {
  ctx.ui.setStatus(STATUS_KEY, undefined);
}
```

### Steps

- [ ] **Step 1: Add `LoopStatusReporter` to the import in `tool-definitions.ts`**

- [ ] **Step 2: Build `statusReporter` object inside `execute` function**

  - Add `const STATUS_KEY = "loop";`
  - Add `const maxIterations = params.maxIterations ?? 10;`
  - Add the `statusReporter` const (conditional on `ctx.hasUI`)

- [ ] **Step 3: Pass `maxIterations` and `statusReporter` to `createLoopCallbacks`**

- [ ] **Step 4: Clear status after loop completes**

  Wrap `runDecomposedLoop` in a try/finally, calling `ctx.ui.setStatus(STATUS_KEY, undefined)` in the finally block when `ctx.hasUI`.

- [ ] **Step 5: Run all tests**

  Run: `npm test`
  Expected: all 152 tests pass (no new tests needed for tool-definitions.ts — the `ctx.hasUI` branch is integration-only)

- [ ] **Step 6: Verify TypeScript compiles cleanly**

  Run: `npm run build` or `npx tsc --noEmit`
  Expected: no errors

- [ ] **Step 7: Commit**

  ```bash
  git add src/tools/tool-definitions.ts
  git commit -m "feat(tools): wire LoopStatusReporter to ctx.ui.setStatus in start_research_loop"
  ```

---

## Task 3: Fix `src/index.ts` undefined model guard and update docs

**Files:**
- Modify: `src/index.ts`
- Modify: `docs/api-reference.md`
- Modify: `README.md`

### What to fix in `index.ts`

`session.model` is typed `Model<any> | undefined` but `resolveAgentModel` expects `Model<any>`. Add guards:

```typescript
registry.register("worker", async () => {
  if (!session.model) throw new Error("No model selected. Use /model to select a model.");
  return createWorkerAgent({
    configDir: workerConfigDir,
    sandboxDir,
    model: resolveAgentModel("worker", session.model, session.modelRegistry),
    getApiKey
  });
});

registry.register("manager", async () => {
  if (!session.model) throw new Error("No model selected. Use /model to select a model.");
  return createManagerAgent({
    configDir: managerConfigDir,
    workerConfigDir,
    sandboxDir,
    model: resolveAgentModel("manager", session.model, session.modelRegistry),
    getApiKey
  });
});
```

### What to update in `docs/api-reference.md`

Find the `LoopIntegrationOptions` section and add the two new fields. Find the `createLoopCallbacks` section and add a `LoopStatusReporter` subsection above it.

**Add to `LoopIntegrationOptions` code block:**
```typescript
maxIterations?: number;          // Max iterations for status display (default 10)
statusReporter?: LoopStatusReporter; // Phase-level status callbacks
```

**Add new section before `createLoopCallbacks`:**
```markdown
### `LoopStatusReporter`

Callback interface for per-phase status updates. Connect to `ctx.ui.setStatus()` for persistent TUI footer display during long-running loops.

\```typescript
export interface LoopStatusReporter {
  onWorkerStart(iteration: number, maxIterations: number): void;
  onEvaluationStart(iteration: number, maxIterations: number): void;
  onFeedbackWaiting(iteration: number, maxIterations: number, score: number): void;
  onImprovementStart(iteration: number, maxIterations: number): void;
  onLoopComplete(totalIterations: number, finalScore: number): void;
  onLoopInterrupted(iteration: number): void;
}
\```

`start_research_loop` automatically wires this to `ctx.ui.setStatus("loop", ...)` and `ctx.ui.setWorkingMessage()` when running in interactive TUI mode (`ctx.hasUI === true`).
```

### What to update in `README.md`

Find the test count (e.g., "146 tests") and update to match the final count after Task 1.

### Steps

- [ ] **Step 1: Fix `src/index.ts` — add guards**

- [ ] **Step 2: Verify TypeScript compiles cleanly**

  Run: `npx tsc --noEmit`

- [ ] **Step 3: Update `docs/api-reference.md`**

  First read the file to find exact insertion points.

- [ ] **Step 4: Update `README.md` test count**

  Run `npm test` to get the final count, then update the README.

- [ ] **Step 5: Commit all three**

  ```bash
  git add src/index.ts docs/api-reference.md README.md
  git commit -m "fix(index): guard against undefined session.model; docs: document LoopStatusReporter API"
  ```
