import type { Agent } from "@mariozechner/pi-agent-core";

type AgentFactory = () => Promise<Agent>;

export class AgentRegistry {
  private readonly factories = new Map<string, AgentFactory>();
  private readonly instances = new Map<string, Agent>();
  private readonly pending = new Map<string, Promise<Agent>>();

  register(name: string, factory: AgentFactory): void {
    this.factories.set(name, factory);
  }

  has(name: string): boolean {
    return this.factories.has(name);
  }

  async get(name: string): Promise<Agent> {
    const existing = this.instances.get(name);
    if (existing) {
      return existing;
    }

    const inFlight = this.pending.get(name);
    if (inFlight) {
      return inFlight;
    }

    const factory = this.factories.get(name);
    if (!factory) {
      throw new Error(`Agent '${name}' is not registered`);
    }

    const initialized = factory().then((agent) => {
      this.instances.set(name, agent);
      this.pending.delete(name);
      return agent;
    }).catch((error) => {
      this.pending.delete(name);
      throw error;
    });

    this.pending.set(name, initialized);
    return initialized;
  }

  getInitializedNames(): string[] {
    return [...this.instances.keys()];
  }

  evict(name: string): void {
    const existing = this.instances.get(name);
    if (existing) {
      existing.reset();
      this.instances.delete(name);
    }
  }

  shutdownAll(): void {
    for (const agent of this.instances.values()) {
      agent.reset();
    }
  }
}
