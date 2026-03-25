import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import type { Agent } from "@mariozechner/pi-agent-core";

import { invokeAgent } from "./invoke-agent.js";

function createMockAgent(overrides?: {
  prompt?: () => Promise<void>;
  waitForIdle?: () => Promise<void>;
  messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
}): {
  agent: Agent;
  prompt: ReturnType<typeof mock.fn>;
  waitForIdle: ReturnType<typeof mock.fn>;
} {
  const prompt = mock.fn(overrides?.prompt ?? (async () => {}));
  const waitForIdle = mock.fn(overrides?.waitForIdle ?? (async () => {}));

  const agent = {
    prompt,
    waitForIdle,
    state: {
      messages: overrides?.messages ?? [],
      systemPrompt: "",
      tools: []
    },
    subscribe: mock.fn(() => () => {}),
    reset: mock.fn(() => {}),
    setTools: mock.fn(() => {})
  };

  return {
    agent: agent as unknown as Agent,
    prompt,
    waitForIdle
  };
}

afterEach(() => {
  mock.restoreAll();
});

describe("invokeAgent", () => {
  it("returns normal result when signal is not provided", async () => {
    const { agent, prompt, waitForIdle } = createMockAgent({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "final response" }] }
      ]
    });

    const result = await invokeAgent(agent, "do task");

    assert.equal(prompt.mock.calls.length, 1);
    assert.deepEqual(prompt.mock.calls[0]?.arguments, ["do task"]);
    assert.equal(waitForIdle.mock.calls.length, 1);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "final response" }],
      details: undefined
    });
  });

  it("returns normal result when signal is provided and not aborted", async () => {
    const { agent, prompt, waitForIdle } = createMockAgent({
      messages: [
        { role: "assistant", content: [{ type: "text", text: "with signal" }] }
      ]
    });
    const controller = new AbortController();

    const result = await invokeAgent(agent, "do task", controller.signal);

    assert.equal(prompt.mock.calls.length, 1);
    assert.equal(waitForIdle.mock.calls.length, 1);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "with signal" }],
      details: undefined
    });
  });

  it("throws AbortError immediately when signal is already aborted", async () => {
    const { agent, prompt, waitForIdle } = createMockAgent();
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => invokeAgent(agent, "do task", controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof DOMException);
        assert.equal(error.name, "AbortError");
        return true;
      }
    );

    assert.equal(prompt.mock.calls.length, 0);
    assert.equal(waitForIdle.mock.calls.length, 0);
  });

  it("throws AbortError when aborted during waitForIdle", async () => {
    const { agent, prompt, waitForIdle } = createMockAgent({
      waitForIdle: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
      },
      messages: [{ role: "assistant", content: [{ type: "text", text: "late" }] }]
    });
    const controller = new AbortController();

    const run = invokeAgent(agent, "do task", controller.signal);
    setTimeout(() => controller.abort(), 5);

    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "AbortError");
      return true;
    });

    assert.equal(prompt.mock.calls.length, 1);
    assert.equal(waitForIdle.mock.calls.length, 1);
  });

  it("returns isError result for non-abort agent errors", async () => {
    const { agent } = createMockAgent({
      prompt: async () => {
        throw new Error("boom");
      }
    });

    const result = await invokeAgent(agent, "do task");

    assert.equal(result.isError, true);
    assert.equal(result.content[0]?.type, "text");
    assert.equal(result.content[0]?.text.includes("boom"), true);
  });

  it("removes abort listener when waitForIdle resolves", async () => {
    const { agent } = createMockAgent({
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }]
    });
    const controller = new AbortController();

    const removeSpy = mock.method(controller.signal, "removeEventListener");

    const result = await invokeAgent(agent, "do task", controller.signal);

    assert.equal(result.content[0]?.type, "text");
    assert.equal(removeSpy.mock.calls.length, 1);
    assert.equal(removeSpy.mock.calls[0]?.arguments[0], "abort");
    assert.equal(typeof removeSpy.mock.calls[0]?.arguments[1], "function");
  });

  it("handles abort that happens between prompt completion and wait phase setup", async () => {
    const controller = new AbortController();
    const { agent } = createMockAgent({
      prompt: async () => {
        controller.abort();
      },
      waitForIdle: async () => {
        await new Promise(() => {});
      }
    });

    await assert.rejects(
      () => invokeAgent(agent, "do task", controller.signal),
      (error: unknown) => {
        assert.ok(error instanceof DOMException);
        assert.equal(error.name, "AbortError");
        return true;
      }
    );
  });
});
