import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { buildImprovementRequests, type ImprovementRequest } from "./improvement-request.js";
import type { EvaluationReport } from "./evaluation-report.js";

export interface LoopConfig {
  maxIterations: number;
  iterationTimeoutMs: number;
  stateDir?: string;
  resumeFromIteration?: number;
}

export interface IterationResult {
  iteration: number;
  workProduct: string;
  evaluation: EvaluationReport;
  improvements: string[];
  latencyMs: LatencyRecord;
  outcome: "user-approved" | "improvement-applied" | "max-iterations" | "user-interrupted" | "timeout";
}

export interface LatencyRecord {
  workerExecutionMs: number;
  evaluationMs: number;
  managerImprovementMs: number;
  totalMs: number;
}

export interface WorkerContext {
  iteration: number;
  previousEvaluation?: EvaluationReport;
  previousFeedback?: string;
}

export interface LoopCallbacks {
  executeWorker: (task: string, context: WorkerContext) => Promise<string>;
  evaluateProduct: (workProduct: string) => Promise<EvaluationReport>;
  getUserFeedback: (workProduct: string, evaluation: EvaluationReport, iteration: number) => Promise<UserFeedback>;
  executeImprovement: (requests: ImprovementRequest[]) => Promise<string[]>;
  onIterationComplete: (result: IterationResult) => void;
  onIterationStateSaved?: (iteration: number, stateFile: string) => void;
  readCurrentConfig: () => Promise<string>;
  waitForInterrupt?: () => Promise<InterruptRequest>;
}

export type InterruptRequest =
  | { type: "stop" }
  | { type: "modify"; feedback: string };

export type UserFeedback =
  | { type: "approved" }
  | { type: "improve"; feedback: string }
  | { type: "interrupt" };

const defaultConfig: LoopConfig = {
  maxIterations: 10,
  iterationTimeoutMs: 600_000
};

export interface LoopState {
  task: string;
  currentIteration: number;
  results: IterationResult[];
  lastFeedback?: string;
  status: "in-progress" | "completed" | "interrupted" | "crashed";
  startedAt: string;
  updatedAt: string;
}

const STATE_FILENAME = "loop-state.json";
const UTF8 = "utf-8";

async function saveLoopState(stateDir: string, state: LoopState): Promise<string> {
  await mkdir(stateDir, { recursive: true });
  const filePath = join(stateDir, STATE_FILENAME);
  await writeFile(filePath, JSON.stringify(state, null, 2), UTF8);
  return filePath;
}

export async function loadLoopState(stateDir: string): Promise<LoopState | null> {
  try {
    const filePath = join(stateDir, STATE_FILENAME);
    const content = await readFile(filePath, UTF8);
    return JSON.parse(content) as LoopState;
  } catch {
    return null;
  }
}

const timeoutErrorMessage = "iteration-timeout";

function now(): number {
  return Date.now();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const handle = setTimeout(() => {
      reject(new Error(timeoutErrorMessage));
    }, timeoutMs);

    void promise.then(
      (value) => {
        clearTimeout(handle);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(handle);
        reject(error);
      }
    );
  });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === timeoutErrorMessage;
}

type InterruptRaced<T> =
  | { kind: "value"; value: T }
  | { kind: "interrupt"; request: InterruptRequest };

/** Like `withTimeout`, but also races against an optional interrupt promise.
 *  Returns a tagged union so callers can distinguish the two outcomes. */
async function withTimeoutAndInterrupt<T>(
  promise: Promise<T>,
  timeoutMs: number,
  interruptPromise: Promise<InterruptRequest> | undefined
): Promise<InterruptRaced<T>> {
  const timedPromise = withTimeout(promise, timeoutMs);
  if (!interruptPromise) {
    return { kind: "value", value: await timedPromise };
  }
  return Promise.race([
    timedPromise.then((value) => ({ kind: "value", value }) as const),
    interruptPromise.then((request) => ({ kind: "interrupt", request }) as const)
  ]);
}

function emptyEvaluation(): EvaluationReport {
  return {
    qualityScore: 0,
    summary: "Iteration timed out.",
    issues: []
  };
}

function createResult(params: {
  iteration: number;
  startMs: number;
  workProduct: string;
  evaluation: EvaluationReport;
  improvements: string[];
  workerExecutionMs: number;
  evaluationMs: number;
  managerImprovementMs: number;
  outcome: IterationResult["outcome"];
}): IterationResult {
  return {
    iteration: params.iteration,
    workProduct: params.workProduct,
    evaluation: params.evaluation,
    improvements: params.improvements,
    latencyMs: {
      workerExecutionMs: params.workerExecutionMs,
      evaluationMs: params.evaluationMs,
      managerImprovementMs: params.managerImprovementMs,
      totalMs: Math.max(0, now() - params.startMs)
    },
    outcome: params.outcome
  };
}

export async function runPersistenceLoop(
  task: string,
  callbacks: LoopCallbacks,
  config?: Partial<LoopConfig>
): Promise<IterationResult[]> {
  const loopConfig: LoopConfig = {
    ...defaultConfig,
    ...config
  };
  const results: IterationResult[] = [];
  const startIteration = loopConfig.resumeFromIteration ?? 1;
  let lastEvaluation: EvaluationReport | undefined;
  let lastFeedback: string | undefined;

  const loopState: LoopState = {
    task,
    currentIteration: startIteration,
    results: [],
    status: "in-progress",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const maybeSaveState = async (): Promise<void> => {
    if (loopConfig.stateDir) {
      loopState.results = results;
      loopState.updatedAt = new Date().toISOString();
      const filePath = await saveLoopState(loopConfig.stateDir, loopState);
      callbacks.onIterationStateSaved?.(loopState.currentIteration, filePath);
    }
  };

  for (let iteration = startIteration; iteration <= loopConfig.maxIterations; iteration += 1) {
    loopState.currentIteration = iteration;
    const iterationStart = now();
    let workProduct = "";
    let evaluation: EvaluationReport = emptyEvaluation();
    let improvements: string[] = [];
    let workerExecutionMs = 0;
    let evaluationMs = 0;
    let managerImprovementMs = 0;
    // Fresh interrupt channel for each phase within this iteration
    let currentInterruptPromise: Promise<InterruptRequest> | undefined;

    try {
      const workerContext: WorkerContext = {
        iteration,
        previousEvaluation: lastEvaluation,
        previousFeedback: lastFeedback
      };

      const workerStart = now();
      const workerPromise = withTimeout(callbacks.executeWorker(task, workerContext), loopConfig.iterationTimeoutMs);

      if (callbacks.waitForInterrupt) {
        currentInterruptPromise = callbacks.waitForInterrupt();
        void currentInterruptPromise.catch(() => undefined);
        const raced = await Promise.race([
          workerPromise.then((value) => ({ kind: "worker", value }) as const),
          currentInterruptPromise.then((request) => ({ kind: "interrupt", request }) as const)
        ]);

        if (raced.kind === "interrupt") {
          void workerPromise.catch(() => undefined);
          workerExecutionMs = Math.max(0, now() - workerStart);
          const interruptedResult = createResult({
            iteration,
            startMs: iterationStart,
            workProduct: "",
            evaluation: emptyEvaluation(),
            improvements: [],
            workerExecutionMs,
            evaluationMs,
            managerImprovementMs,
            outcome: "user-interrupted"
          });
          results.push(interruptedResult);
          callbacks.onIterationComplete(interruptedResult);
          await maybeSaveState();

          if (raced.request.type === "stop") {
            loopState.status = "interrupted";
            await maybeSaveState();
            return results;
          }

          lastFeedback = raced.request.feedback;
          lastEvaluation = undefined;
          loopState.lastFeedback = raced.request.feedback;
          continue;
        }

        workProduct = raced.value;
        workerExecutionMs = Math.max(0, now() - workerStart);
      } else {
        workProduct = await workerPromise;
        workerExecutionMs = Math.max(0, now() - workerStart);
      }

      // --- Evaluation phase ---
      const evaluationStart = now();
      currentInterruptPromise = callbacks.waitForInterrupt?.();
      if (currentInterruptPromise) void currentInterruptPromise.catch(() => undefined);
      const evalRaced = await withTimeoutAndInterrupt(
        callbacks.evaluateProduct(workProduct),
        loopConfig.iterationTimeoutMs,
        currentInterruptPromise
      );
      if (evalRaced.kind === "interrupt") {
        evaluationMs = Math.max(0, now() - evaluationStart);
        const interruptedResult = createResult({
          iteration, startMs: iterationStart, workProduct,
          evaluation: emptyEvaluation(), improvements: [],
          workerExecutionMs, evaluationMs, managerImprovementMs,
          outcome: "user-interrupted"
        });
        results.push(interruptedResult);
        callbacks.onIterationComplete(interruptedResult);
        if (evalRaced.request.type === "stop") {
          loopState.status = "interrupted";
          await maybeSaveState();
          return results;
        }
        lastFeedback = evalRaced.request.feedback;
        lastEvaluation = undefined;
        loopState.lastFeedback = evalRaced.request.feedback;
        await maybeSaveState();
        continue;
      }
      evaluation = evalRaced.value;
      evaluationMs = Math.max(0, now() - evaluationStart);

      // --- User feedback phase ---
      currentInterruptPromise = callbacks.waitForInterrupt?.();
      if (currentInterruptPromise) void currentInterruptPromise.catch(() => undefined);
      const feedbackRaced = await withTimeoutAndInterrupt(
        callbacks.getUserFeedback(workProduct, evaluation, iteration),
        loopConfig.iterationTimeoutMs,
        currentInterruptPromise
      );
      if (feedbackRaced.kind === "interrupt") {
        const interruptedResult = createResult({
          iteration, startMs: iterationStart, workProduct, evaluation, improvements: [],
          workerExecutionMs, evaluationMs, managerImprovementMs,
          outcome: "user-interrupted"
        });
        results.push(interruptedResult);
        callbacks.onIterationComplete(interruptedResult);
        if (feedbackRaced.request.type === "stop") {
          loopState.status = "interrupted";
          await maybeSaveState();
          return results;
        }
        lastFeedback = feedbackRaced.request.feedback;
        lastEvaluation = evaluation;
        loopState.lastFeedback = feedbackRaced.request.feedback;
        await maybeSaveState();
        continue;
      }
      const feedback = feedbackRaced.value;

      if (feedback.type === "approved") {
        const result = createResult({
          iteration,
          startMs: iterationStart,
          workProduct,
          evaluation,
          improvements,
          workerExecutionMs,
          evaluationMs,
          managerImprovementMs,
          outcome: "user-approved"
        });
        results.push(result);
        callbacks.onIterationComplete(result);
        loopState.status = "completed";
        await maybeSaveState();
        return results;
      }

      if (feedback.type === "interrupt") {
        const result = createResult({
          iteration,
          startMs: iterationStart,
          workProduct,
          evaluation,
          improvements,
          workerExecutionMs,
          evaluationMs,
          managerImprovementMs,
          outcome: "user-interrupted"
        });
        results.push(result);
        callbacks.onIterationComplete(result);
        loopState.status = "interrupted";
        await maybeSaveState();
        return results;
      }

      lastEvaluation = evaluation;
      lastFeedback = feedback.feedback;
      loopState.lastFeedback = feedback.feedback;

      // --- Improvement phase ---
      const managerStart = now();
      const currentConfig = await withTimeout(callbacks.readCurrentConfig(), loopConfig.iterationTimeoutMs);
      const requests = buildImprovementRequests(evaluation, workProduct, currentConfig, feedback.feedback);
      currentInterruptPromise = callbacks.waitForInterrupt?.();
      if (currentInterruptPromise) void currentInterruptPromise.catch(() => undefined);
      const improveRaced = await withTimeoutAndInterrupt(
        callbacks.executeImprovement(requests),
        loopConfig.iterationTimeoutMs,
        currentInterruptPromise
      );
      if (improveRaced.kind === "interrupt") {
        managerImprovementMs = Math.max(0, now() - managerStart);
        const interruptedResult = createResult({
          iteration, startMs: iterationStart, workProduct, evaluation, improvements: [],
          workerExecutionMs, evaluationMs, managerImprovementMs,
          outcome: "user-interrupted"
        });
        results.push(interruptedResult);
        callbacks.onIterationComplete(interruptedResult);
        if (improveRaced.request.type === "stop") {
          loopState.status = "interrupted";
          await maybeSaveState();
          return results;
        }
        lastFeedback = improveRaced.request.feedback;
        loopState.lastFeedback = improveRaced.request.feedback;
        await maybeSaveState();
        continue;
      }
      improvements = improveRaced.value;
      managerImprovementMs = Math.max(0, now() - managerStart);

      const outcome: IterationResult["outcome"] = iteration === loopConfig.maxIterations ? "max-iterations" : "improvement-applied";
      const result = createResult({
        iteration,
        startMs: iterationStart,
        workProduct,
        evaluation,
        improvements,
        workerExecutionMs,
        evaluationMs,
        managerImprovementMs,
        outcome
      });
      results.push(result);
      callbacks.onIterationComplete(result);
      await maybeSaveState();

      if (outcome === "max-iterations") {
        loopState.status = "completed";
        await maybeSaveState();
        return results;
      }
    } catch (error: unknown) {
      if (!isTimeoutError(error)) {
        loopState.status = "crashed";
        await maybeSaveState();
        throw error;
      }
      const timeoutResult = createResult({
        iteration,
        startMs: iterationStart,
        workProduct,
        evaluation,
        improvements,
        workerExecutionMs,
        evaluationMs,
        managerImprovementMs,
        outcome: "timeout"
      });
      results.push(timeoutResult);
      callbacks.onIterationComplete(timeoutResult);
      loopState.status = "interrupted";
      await maybeSaveState();
      return results;
    }
  }

  return results;
}
