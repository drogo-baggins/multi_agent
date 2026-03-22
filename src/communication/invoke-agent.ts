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

export async function invokeAgent(agent: Agent, message: string): Promise<AgentToolResult<void>> {
  try {
    await agent.prompt(message);
    await agent.waitForIdle();

    const messages = agent.state.messages;
    const lastAssistant = [...messages].reverse().find(isAssistantMessage);
    const text = lastAssistant ? extractTextFromMessages([lastAssistant]) : "";

    return {
      content: [{ type: "text", text }],
      details: undefined
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: errorMessage }],
      details: undefined,
      isError: true
    } as AgentToolResult<void>;
  }
}
