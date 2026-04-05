import { type Page } from "playwright-core";
import * as readline from "node:readline/promises";

import { getOrCreateBrowser, navigateTo, closeDedicatedTab } from "./cdp-session.js";

export interface CdpCaptureOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  signal?: AbortSignal;
}

export interface CdpCaptureResult {
  html: string;
  url: string;
  title: string;
  skipped: boolean;
}

async function waitForUserEnter(prompt: string, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) {
    return true;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let onAbort: (() => void) | undefined;
  try {
    const questionPromise = rl.question(prompt);
    if (!signal) {
      const answer = await questionPromise;
      return answer.trim().toLowerCase() === "skip";
    }

    const abortPromise = new Promise<boolean>((resolve) => {
      onAbort = () => {
        signal.removeEventListener("abort", onAbort!);
        rl.close();
        resolve(true);
      };

      signal.addEventListener("abort", onAbort, { once: true });
    });

    const answer = await Promise.race([questionPromise, abortPromise]);
    if (typeof answer !== "string") {
      return true;
    }

    return answer.trim().toLowerCase() === "skip";
  } finally {
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    rl.close();
  }
}

async function waitForCaptureReady(page: Page, waitUntil: NonNullable<CdpCaptureOptions["waitUntil"]>): Promise<void> {
  await page.waitForLoadState(waitUntil, { timeout: 15_000 }).catch(() => {
    process.stdout.write(`[human mode] 読み込みタイムアウト。現在のDOMを取得します。\n`);
  });
}

async function resetDedicatedTitle(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.title = "pi-agent-dedicated";
    })
    .catch(() => {
      void 0;
    });
}

export async function capturePageWithCdp(
  targetUrl: string,
  options: CdpCaptureOptions = {}
): Promise<CdpCaptureResult> {
  const waitUntil = options.waitUntil ?? "networkidle";

  if (options.signal?.aborted) {
    return { html: "", url: targetUrl, title: "", skipped: true };
  }

  await getOrCreateBrowser();
  const page = await navigateTo(targetUrl, "domcontentloaded");

  const urlDisplay = targetUrl.length > 70
    ? targetUrl.slice(0, 67) + "..."
    : targetUrl;

  process.stdout.write(`\n`);
  process.stdout.write(`╔══════════════════════════════════════════════════════════════════╗\n`);
  process.stdout.write(`║  【Human Mode】 あなたの操作が必要です                           ║\n`);
  process.stdout.write(`╠══════════════════════════════════════════════════════════════════╣\n`);
  process.stdout.write(`║  Chrome ブラウザで以下のページを自動で開いています:              ║\n`);
  process.stdout.write(`║  ${urlDisplay.padEnd(66)}  ║\n`);
  process.stdout.write(`║                                                                  ║\n`);
  process.stdout.write(`║  ページが表示されたら、このターミナルに戻って                    ║\n`);
  process.stdout.write(`║                                                                  ║\n`);
  process.stdout.write(`║         >> ENTER キーを押してください <<                         ║\n`);
  process.stdout.write(`║                                                                  ║\n`);
  process.stdout.write(`║  ※ページをスキップする場合は "SKIP" と入力して ENTER            ║\n`);
  process.stdout.write(`╚══════════════════════════════════════════════════════════════════╝\n`);
  process.stdout.write(`\n> `);
  const skipped = await waitForUserEnter("", options.signal);

  if (skipped) {
    process.stdout.write(`[human mode] スキップしました: ${targetUrl}\n`);
    return { html: "", url: targetUrl, title: "", skipped: true };
  }

  await waitForCaptureReady(page, waitUntil);

  const finalUrl = page.url();
  const title = await page.title();
  const html = await page.content();
  process.stdout.write(`[human mode] 取得完了: ${title} (${html.length.toLocaleString()} 文字)\n`);
  await resetDedicatedTitle(page);

  return { html, url: finalUrl, title, skipped: false };
}

process.once("exit", () => {
  void closeDedicatedTab();
});
