import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadSearchConfig } from "./search-config.js";

export const CDP_PORT = 9222;

export function getUserDataDir(): string {
  return join(tmpdir(), "pi-agent-chrome-profile");
}

export function buildChromeArgs(): string[] {
  const config = loadSearchConfig();
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${getUserDataDir()}`,
    "--no-first-run",
    "--no-default-browser-check"
  ];

  if (config.chromeWindowPosition) {
    args.push(`--window-position=${config.chromeWindowPosition}`);
  }

  if (config.chromeWindowSize) {
    args.push(`--window-size=${config.chromeWindowSize}`);
  }

  return args;
}

function chromeCandidates(): string[] {
  const fromEnv = process.env["CHROME_PATH"] ?? process.env["CHROMIUM_PATH"];
  switch (process.platform) {
    case "win32":
      return [
        ...(fromEnv ? [fromEnv] : []),
        `${process.env["LOCALAPPDATA"] ?? ""}\\Google\\Chrome\\Application\\chrome.exe`,
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ];
    case "darwin":
      return [
        ...(fromEnv ? [fromEnv] : []),
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
      ];
    default:
      return [
        ...(fromEnv ? [fromEnv] : []),
        "/usr/bin/google-chrome",
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        "/snap/bin/chromium",
      ];
  }
}

export function findChromeExecutable(): string {
  for (const candidate of chromeCandidates()) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  const candidates = chromeCandidates().filter(Boolean);
  return candidates[0] ?? "google-chrome";
}

export async function waitForCdpReady(port: number = CDP_PORT, deadlineMs: number = 15_000): Promise<string> {
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
    } catch {
      void 0;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 300));
  }

  throw new Error(
    `[human mode] CDP not ready on port ${port} after ${deadlineMs}ms. ` +
      `Make sure Chrome is running with: --remote-debugging-port=${port}`
  );
}

export async function launchChromeWithCdp(): Promise<void> {
  const exe = findChromeExecutable();
  const args = buildChromeArgs();

  return new Promise<void>((resolve, reject) => {
    const child = spawn(exe, args, {
      detached: true,
      stdio: "ignore",
    });

    child.once("spawn", () => {
      child.unref();
      resolve();
    });

    child.once("error", err => {
      const manual = `"${exe}" ${args.join(" ")}`;
      process.stderr.write(
        `[human mode] Chrome の自動起動に失敗しました。\n` +
          `手動で以下のコマンドで Chrome を起動してください:\n` +
          `  ${manual}\n`
      );
      reject(err);
    });
  });
}

export async function ensureChromeReady(
  port: number = CDP_PORT,
  launchIfNeeded: boolean = true
): Promise<string> {
  try {
    return await waitForCdpReady(port, 3000);
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

  return await waitForCdpReady(port, 20000);
}
