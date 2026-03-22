import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { Agent, AgentEvent, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

import { AgentRegistry } from "./agent-registry.js";
import { relayEvents } from "./event-relay.js";
import { extractTextFromMessages, invokeAgent } from "./invoke-agent.js";

function createMockAgent(overrides?: {
  prompt?: (message: string) => Promise<void>;
  waitForIdle?: () => Promise<void>;
  messages?: unknown[];
}): Agent {
  const listeners = new Set<(event: AgentEvent) => void>();
  const mock = {
    state: {
      messages: overrides?.messages ?? []
    },
    async prompt(message: string) {
      if (overrides?.prompt) {
        await overrides.prompt(message);
      }
    },
    async waitForIdle() {
      if (overrides?.waitForIdle) {
        await overrides.waitForIdle();
      }
    },
    resetCalls: 0,
    reset() {
      this.resetCalls += 1;
    },
    subscribe(listener: (event: AgentEvent) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit(event: AgentEvent) {
      for (const listener of listeners) {
        listener(event);
      }
    }
  };

  return mock as unknown as Agent;
}

describe("AgentRegistry", () => {
  it("lazily initializes agents only on first get", async () => {
    const registry = new AgentRegistry();
    let factoryCalls = 0;

    registry.register("child", async () => {
      factoryCalls += 1;
      return createMockAgent();
    });

    assert.equal(factoryCalls, 0);
    await registry.get("child");
    assert.equal(factoryCalls, 1);
    await registry.get("child");
    assert.equal(factoryCalls, 1);
  });

  it("reuses same instance across repeated get calls", async () => {
    const registry = new AgentRegistry();
    const agent = createMockAgent();
    registry.register("worker", async () => agent);

    const first = await registry.get("worker");
    const second = await registry.get("worker");

    assert.equal(first, second);
  });

  it("shutdownAll resets all initialized agents", async () => {
    const registry = new AgentRegistry();
    const one = createMockAgent() as unknown as { resetCalls: number } & Agent;
    const two = createMockAgent() as unknown as { resetCalls: number } & Agent;

    registry.register("one", async () => one);
    registry.register("two", async () => two);
    registry.register("three", async () => createMockAgent());

    await registry.get("one");
    await registry.get("two");
    registry.shutdownAll();

    assert.equal(one.resetCalls, 1);
    assert.equal(two.resetCalls, 1);
  });

  it("throws when getting unregistered agent", async () => {
    const registry = new AgentRegistry();

    await assert.rejects(() => registry.get("missing"), /missing/);
  });

  it("tracks registration and initialized names", async () => {
    const registry = new AgentRegistry();
    registry.register("alpha", async () => createMockAgent());
    registry.register("beta", async () => createMockAgent());

    assert.equal(registry.has("alpha"), true);
    assert.equal(registry.has("gamma"), false);
    assert.deepEqual(registry.getInitializedNames(), []);

    await registry.get("beta");
    await registry.get("alpha");

    assert.deepEqual(registry.getInitializedNames().sort(), ["alpha", "beta"]);
  });
});

describe("invokeAgent", () => {
  it("prompts child agent and returns text from latest assistant message", async () => {
    let prompted = "";
    let waited = false;
    const agent = createMockAgent({
      prompt: async (message: string) => {
        prompted = message;
      },
      waitForIdle: async () => {
        waited = true;
      },
      messages: [
        { role: "assistant", content: [{ type: "text", text: "older" }] },
        { role: "user", content: [{ type: "text", text: "ignore" }] },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "internal" },
            { type: "text", text: "latest" },
            { type: "text", text: " reply" }
          ]
        }
      ]
    });

    const result = await invokeAgent(agent, "hello child");

    assert.equal(prompted, "hello child");
    assert.equal(waited, true);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "latest reply" }],
      details: undefined
    });
  });

  it("returns error tool result with isError when prompt throws", async () => {
    const agent = createMockAgent({
      prompt: async () => {
        throw new Error("boom");
      }
    });

    const result = await invokeAgent(agent, "hello") as { content: { type: string; text: string }[]; isError?: boolean };

    assert.equal(result.content[0].text, "boom");
    assert.equal(result.isError, true);
  });
});

describe("extractTextFromMessages", () => {
  it("extracts only text content from assistant messages", () => {
    const text = extractTextFromMessages([
      { role: "user", content: [{ type: "text", text: "ignore" }] },
      {
        role: "assistant",
        content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "a" }]
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "b" }, { type: "tool_call", toolName: "t", toolCallId: "1", args: {} }]
      }
    ] as never);

    assert.equal(text, "a\nb");
  });
});

describe("relayEvents", () => {
  it("forwards child events to onUpdate callback and supports unsubscribe", () => {
    const updates: unknown[] = [];
    const onUpdate: AgentToolUpdateCallback<unknown> = (partialResult) => {
      updates.push(partialResult);
    };

    const child = createMockAgent() as unknown as Agent & { emit: (event: AgentEvent) => void };
    const unsubscribe = relayEvents(child, onUpdate);

    const event: AgentEvent = { type: "agent_start" };
    child.emit(event);

    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0], {
      content: [{ type: "text", text: JSON.stringify(event) }],
      details: event
    });

    unsubscribe();
    child.emit({ type: "turn_start" });
    assert.equal(updates.length, 1);
  });
});
