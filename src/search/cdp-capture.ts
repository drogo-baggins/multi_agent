import { type Page } from "playwright-core";
import * as readline from "node:readline/promises";

import { getOrCreateBrowser, navigateTo, closeDedicatedTab } from "./cdp-session.js";

export interface CdpCaptureOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface CdpCaptureResult {
  html: string;
  url: string;
  title: string;
  skipped: boolean;
}

async function waitForUserEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(prompt);
  } finally {
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

  await getOrCreateBrowser();
  const page = await navigateTo(targetUrl, "domcontentloaded");

  process.stdout.write(`\n`);
  process.stdout.write(`┌─────────────────────────────────────────────────────────┐\n`);
  process.stdout.write(`│  [human mode] ブラウザでページを確認してください          │\n`);
  process.stdout.write(`│  ${targetUrl.slice(0, 55).padEnd(55)}  │\n`);
  process.stdout.write(`│                                                         │\n`);
  process.stdout.write(`│  >>> ページが表示されたら ENTER を押してください <<<      │\n`);
  process.stdout.write(`└─────────────────────────────────────────────────────────┘\n`);
  process.stdout.write(`\n`);
  await waitForUserEnter("");

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
