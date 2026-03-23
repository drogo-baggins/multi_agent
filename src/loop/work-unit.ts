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
