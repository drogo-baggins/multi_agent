import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execAsync = promisify(exec);

export const CDP_PORT = 9222;

export function getUserDataDir(): string {
  return join(tmpdir(), "pi-agent-chrome-profile");
}

export function buildChromeArgs(): string[] {
  return [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${getUserDataDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

function getChromeExecutable(): string {
  switch (process.platform) {
    case "win32":
      return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    case "darwin":
      return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
    default:
      return "google-chrome";
  }
}

export async function waitForCdpReady(
  port: number = CDP_PORT,
  deadlineMs: number = 15_000
): Promise<string> {
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  const deadline = Date.now() + deadlineMs;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(endpoint, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const json = (await res.json()) as { webSocketDebuggerUrl?: string };
        if (json.webSocketDebuggerUrl) {
          return json.webSocketDebuggerUrl;
        }
      }
    } catch (_e) {
      void _e;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 300));
  }

  throw new Error(
    `[human mode] CDP not ready on port ${port} after ${deadlineMs}ms. ` +
    `Make sure Chrome is running with: --remote-debugging-port=${port}`
  );
}

export async function launchChromeWithCdp(): Promise<void> {
  const exe = getChromeExecutable();
  const args = buildChromeArgs().join(" ");
  const cmd =
    process.platform === "win32"
      ? `start "" "${exe}" ${args}`
      : `"${exe}" ${args} &`;

  try {
    await execAsync(cmd);
  } catch {
    process.stderr.write(
      `[human mode] Chrome の自動起動に失敗しました。\n` +
      `手動で以下のコマンドで Chrome を起動してください:\n` +
      `  "${exe}" ${buildChromeArgs().join(" ")}\n`
    );
  }
}

export async function ensureChromeReady(
  port: number = CDP_PORT,
  launchIfNeeded: boolean = true
): Promise<string> {
  try {
    return await waitForCdpReady(port, 3_000);
  } catch {
    void 0;
  }

  if (!launchIfNeeded) {
    throw new Error(
      `[human mode] CDP not reachable on port ${port}. ` +
      `Start Chrome with --remote-debugging-port=${port}`
    );
  }

  process.stdout.write(`[human mode] Chrome を起動しています...\n`);
  await launchChromeWithCdp();

  return await waitForCdpReady(port, 20_000);
}

interface CdpTargetInfo {
  id?: string;
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Open a URL via CDP /json/new and return the new tab's target ID.
 * Falls back to OS-open when CDP is unreachable (returns undefined).
 */
export async function openUrlAndGetTargetId(
  url: string,
  port: number = CDP_PORT
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
      { signal: AbortSignal.timeout(3000) }
    );
    if (res.ok) {
      const json = (await res.json()) as CdpTargetInfo;
      return json.id;
    }
  } catch {
    void 0;
  }

  // Fallback: OS open (target ID unknown)
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
      ? `open "${url}"`
      : `xdg-open "${url}"`;

  await execAsync(cmd).catch(() => {
    process.stderr.write(`[human mode] ブラウザで手動で開いてください: ${url}\n`);
  });

  return undefined;
}

/**
 * Get the webSocketDebuggerUrl for a given CDP target ID.
 * Returns undefined if not found.
 */
export async function getWsUrlForTargetId(
  targetId: string,
  port: number = CDP_PORT
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/json/list`,
      { signal: AbortSignal.timeout(2000) }
    );
    if (res.ok) {
      const targets = (await res.json()) as CdpTargetInfo[];
      const match = targets.find(t => t.id === targetId);
      return match?.webSocketDebuggerUrl;
    }
  } catch {
    void 0;
  }
  return undefined;
}
