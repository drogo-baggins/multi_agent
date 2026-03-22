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
}

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

    try {
      const workerContext: WorkerContext = {
        iteration,
        previousEvaluation: lastEvaluation,
        previousFeedback: lastFeedback
      };

      const workerStart = now();
      workProduct = await withTimeout(callbacks.executeWorker(task, workerContext), loopConfig.iterationTimeoutMs);
      workerExecutionMs = Math.max(0, now() - workerStart);

      const evaluationStart = now();
      evaluation = await withTimeout(callbacks.evaluateProduct(workProduct), loopConfig.iterationTimeoutMs);
      evaluationMs = Math.max(0, now() - evaluationStart);

      const feedback = await withTimeout(
        callbacks.getUserFeedback(workProduct, evaluation, iteration),
        loopConfig.iterationTimeoutMs
      );

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

      const managerStart = now();
      const currentConfig = await withTimeout(callbacks.readCurrentConfig(), loopConfig.iterationTimeoutMs);
      const requests = buildImprovementRequests(evaluation, workProduct, currentConfig, feedback.feedback);
      improvements = await withTimeout(callbacks.executeImprovement(requests), loopConfig.iterationTimeoutMs);
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
