import type { Model } from "@mariozechner/pi-ai";

export const AGENT_MODEL_ENV_VARS = {
  worker: "WORKER_MODEL",
  manager: "MANAGER_MODEL",
  proxy: "PROXY_MODEL"
} as const;

export type AgentRole = keyof typeof AGENT_MODEL_ENV_VARS;

export interface ModelFinder {
  find(provider: string, modelId: string): Model<any> | undefined;
}

export function parseModelReference(reference: string): { provider: string; modelId: string } | null {
  const trimmed = reference.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const slashIndex = trimmed.indexOf("/");
  if (slashIndex === -1 || slashIndex === 0 || slashIndex === trimmed.length - 1) {
    return null;
  }

  const provider = trimmed.substring(0, slashIndex);
  const modelId = trimmed.substring(slashIndex + 1);
  return { provider, modelId };
}

export function resolveAgentModel(
  role: AgentRole,
  fallbackModel: Model<any>,
  modelFinder: ModelFinder
): Model<any> {
  const envVar = AGENT_MODEL_ENV_VARS[role];
  const envValue = process.env[envVar];

  if (!envValue) {
    return fallbackModel;
  }

  const parsed = parseModelReference(envValue);
  if (!parsed) {
    throw new Error(
      `Invalid ${envVar} format: "${envValue}". Expected "provider/model-id" (e.g., "venice/qwen3-235b").`
    );
  }

  const model = modelFinder.find(parsed.provider, parsed.modelId);
  if (!model) {
    throw new Error(
      `Model not found for ${envVar}="${envValue}". ` +
      `Provider "${parsed.provider}" with model "${parsed.modelId}" is not available. ` +
      `Check the provider name and model ID, and ensure the corresponding API key is set.`
    );
  }

  return model;
}
