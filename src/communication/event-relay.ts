import type { Agent, AgentToolUpdateCallback } from "@mariozechner/pi-agent-core";

export function relayEvents(childAgent: Agent, onUpdate: AgentToolUpdateCallback<any>): () => void {
  return childAgent.subscribe((event) => {
    onUpdate({
      content: [{ type: "text", text: JSON.stringify(event) }],
      details: event
    });
  });
}
