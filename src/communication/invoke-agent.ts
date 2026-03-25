import type { Agent, AgentMessage, AgentToolResult } from "@mariozechner/pi-agent-core";

function isAssistantMessage(message: AgentMessage): message is AgentMessage & { role: "assistant"; content: Array<{ type: string; text?: string }> } {
  return typeof message === "object" && message !== null && "role" in message && (message as { role?: string }).role === "assistant" && "content" in message;
}

export function extractTextFromMessages(messages: AgentMessage[]): string {
  return messages
    .filter(isAssistantMessage)
    .map((message) => message.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text" && "text" in block && typeof block.text === "string")
      .map((block) => block.text)
      .join(""))
    .filter((text) => text.length > 0)
    .join("\n");
}

async function waitForIdleOrAbort(agent: Agent, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };

    const onAbort = () => {
      settle(() => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    };

    signal.addEventListener("abort", onAbort);

    if (signal.aborted) {
      onAbort();
      return;
    }

    agent.waitForIdle().then(
      () => {
        settle(() => {
          resolve();
        });
      },
      (error) => {
        settle(() => {
          reject(error);
        });
      }
    );
  });
}

export async function invokeAgent(agent: Agent, message: string, signal?: AbortSignal): Promise<AgentToolResult<void>> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  try {
    await agent.prompt(message);

    if (signal) {
      await waitForIdleOrAbort(agent, signal);
    } else {
      await agent.waitForIdle();
    }

    const messages = agent.state.messages;
    const lastAssistant = [...messages].reverse().find(isAssistantMessage);
    const text = lastAssistant ? extractTextFromMessages([lastAssistant]) : "";

    return {
      content: [{ type: "text", text }],
      details: undefined
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: errorMessage }],
      details: undefined,
      isError: true
    } as AgentToolResult<void>;
  }
}
