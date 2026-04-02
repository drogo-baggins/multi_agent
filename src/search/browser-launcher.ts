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

export async function launchChromeWithCdp(): Promise<void> {
  const exe = getChromeExecutable();
  const args = buildChromeArgs().join(" ");
  const cmd =
    process.platform === "win32"
      ? `start "" "${exe}" ${args}`
      : `"${exe}" ${args} &`;

  try {
    await execAsync(cmd);
    await new Promise(resolve => setTimeout(resolve, 1500));
  } catch {
    process.stderr.write(
      `[human mode] Chrome の自動起動に失敗しました。\n` +
      `手動で以下のコマンドで Chrome を起動してください:\n` +
      `  "${exe}" ${buildChromeArgs().join(" ")}\n`
    );
  }
}

export async function openUrl(url: string): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`);
  } catch {
    const cmd =
      process.platform === "win32"
        ? `start "" "${url}"`
        : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
    await execAsync(cmd).catch(() => {
      process.stderr.write(`[human mode] ブラウザで手動で開いてください: ${url}\n`);
    });
  }
}
