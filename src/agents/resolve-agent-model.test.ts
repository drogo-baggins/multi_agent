import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import type { Model } from "@mariozechner/pi-ai";

import {
  parseModelReference,
  resolveAgentModel,
  AGENT_MODEL_ENV_VARS,
  type ModelFinder
} from "./resolve-agent-model.js";

function createMockModel(id: string): Model<any> {
  return { id } as unknown as Model<any>;
}

function createMockFinder(models: Map<string, Model<any>>): ModelFinder {
  return {
    find(provider: string, modelId: string) {
      return models.get(`${provider}/${modelId}`);
    }
  };
}

describe("parseModelReference", () => {
  it("parses valid provider/model format", () => {
    const result = parseModelReference("venice/qwen3-235b");
    assert.deepEqual(result, { provider: "venice", modelId: "qwen3-235b" });
  });

  it("handles model IDs containing slashes", () => {
    const result = parseModelReference("openai/gpt-4o");
    assert.deepEqual(result, { provider: "openai", modelId: "gpt-4o" });
  });

  it("trims whitespace", () => {
    const result = parseModelReference("  venice/qwen3-235b  ");
    assert.deepEqual(result, { provider: "venice", modelId: "qwen3-235b" });
  });

  it("returns null for empty string", () => {
    assert.equal(parseModelReference(""), null);
  });

  it("returns null for whitespace-only string", () => {
    assert.equal(parseModelReference("   "), null);
  });

  it("returns null for string without slash", () => {
    assert.equal(parseModelReference("venice-qwen3-235b"), null);
  });

  it("returns null for leading slash", () => {
    assert.equal(parseModelReference("/qwen3-235b"), null);
  });

  it("returns null for trailing slash", () => {
    assert.equal(parseModelReference("venice/"), null);
  });
});

describe("resolveAgentModel", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const touchedKeys: string[] = [];

  function setEnv(key: string, value: string): void {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    touchedKeys.push(key);
    process.env[key] = value;
  }

  function clearEnv(key: string): void {
    if (!(key in savedEnv)) {
      savedEnv[key] = process.env[key];
    }
    touchedKeys.push(key);
    delete process.env[key];
  }

  afterEach(() => {
    for (const key of touchedKeys) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    touchedKeys.length = 0;
  });

  it("returns fallback model when env var is not set", () => {
    clearEnv("WORKER_MODEL");
    const fallback = createMockModel("fallback");
    const finder = createMockFinder(new Map());

    const result = resolveAgentModel("worker", fallback, finder);
    assert.equal(result, fallback);
  });

  it("returns fallback model when env var is empty", () => {
    setEnv("WORKER_MODEL", "");
    const fallback = createMockModel("fallback");
    const finder = createMockFinder(new Map());

    const result = resolveAgentModel("worker", fallback, finder);
    assert.equal(result, fallback);
  });

  it("resolves model from env var when set and found", () => {
    setEnv("WORKER_MODEL", "venice/qwen3-235b");
    const fallback = createMockModel("fallback");
    const expected = createMockModel("venice/qwen3-235b");
    const finder = createMockFinder(new Map([["venice/qwen3-235b", expected]]));

    const result = resolveAgentModel("worker", fallback, finder);
    assert.equal(result, expected);
  });

  it("uses correct env var for each role", () => {
    setEnv("MANAGER_MODEL", "openai/gpt-4o");
    const fallback = createMockModel("fallback");
    const expected = createMockModel("openai/gpt-4o");
    const finder = createMockFinder(new Map([["openai/gpt-4o", expected]]));

    const result = resolveAgentModel("manager", fallback, finder);
    assert.equal(result, expected);
  });

  it("throws on invalid format", () => {
    setEnv("WORKER_MODEL", "invalid-no-slash");
    const fallback = createMockModel("fallback");
    const finder = createMockFinder(new Map());

    assert.throws(
      () => resolveAgentModel("worker", fallback, finder),
      /Invalid WORKER_MODEL format/
    );
  });

  it("throws when model not found in registry", () => {
    setEnv("WORKER_MODEL", "venice/nonexistent-model");
    const fallback = createMockModel("fallback");
    const finder = createMockFinder(new Map());

    assert.throws(
      () => resolveAgentModel("worker", fallback, finder),
      /Model not found for WORKER_MODEL/
    );
  });

  it("reads the correct env var names", () => {
    assert.equal(AGENT_MODEL_ENV_VARS.worker, "WORKER_MODEL");
    assert.equal(AGENT_MODEL_ENV_VARS.manager, "MANAGER_MODEL");
    assert.equal(AGENT_MODEL_ENV_VARS.proxy, "PROXY_MODEL");
  });
});
