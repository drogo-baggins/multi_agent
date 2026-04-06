import { AsyncLocalStorage } from "node:async_hooks";

export interface HumanToolRuntimeCallbacks {
  setWorkingMessage?: (msg: string) => void;
  clearWorkingMessage?: () => void;
  onPromptReady?: (prompt: string) => void;
}

export interface HumanToolCdpCallbacks {
  onPromptReady(prompt: string): void;
}

export interface HumanToolRuntimeController extends HumanToolCdpCallbacks {
  runWithCallbacks<T>(callbacks: HumanToolRuntimeCallbacks, fn: () => Promise<T> | T): Promise<T>;
  setWorkingMessage(msg: string): void;
  clearWorkingMessage(): void;
}

export function createHumanToolStatusController(): HumanToolRuntimeController {
  const storage = new AsyncLocalStorage<HumanToolRuntimeCallbacks>();

  return {
    async runWithCallbacks<T>(callbacks: HumanToolRuntimeCallbacks, fn: () => Promise<T> | T): Promise<T> {
      return await storage.run(callbacks, fn);
    },
    setWorkingMessage(msg: string): void {
      storage.getStore()?.setWorkingMessage?.(msg);
    },
    clearWorkingMessage(): void {
      storage.getStore()?.clearWorkingMessage?.();
    },
    onPromptReady(prompt: string): void {
      storage.getStore()?.onPromptReady?.(prompt);
    }
  };
}