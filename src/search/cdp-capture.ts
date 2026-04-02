import { chromium } from "playwright-core";
import * as readline from "node:readline/promises";
import { CDP_PORT, launchChromeWithCdp } from "./browser-launcher.js";

export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

export function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export interface CdpCaptureOptions {
  timeoutMs?: number;
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface CdpCaptureResult {
  html: string;
  url: string;
  title: string;
  skipped: boolean;
}

export async function capturePageWithCdp(
  targetUrl: string,
  options: CdpCaptureOptions = {}
): Promise<CdpCaptureResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const waitUntil = options.waitUntil ?? "networkidle";
  const normalizedTarget = normalizeUrl(targetUrl);

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 3000 });
  } catch {
    process.stdout.write(`[human mode] Chrome を起動しています...\n`);
    await launchChromeWithCdp();
    try {
      browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 8000 });
    } catch {
      process.stderr.write(
        `[human mode] CDP に接続できません。\n` +
          `Chrome が CDP ポート ${CDP_PORT} で起動しているか確認してください。\n`
      );
      return { html: "", url: targetUrl, title: "", skipped: true };
    }
  }

  try {
    const context = browser.contexts()[0];
    if (!context) {
      return { html: "", url: targetUrl, title: "", skipped: true };
    }

    let page = context.pages().find((p) => normalizeUrl(p.url()) === normalizedTarget);

    if (!page) {
      process.stdout.write(`\n[human mode] ${targetUrl} を開いてください...\n`);
      page = await context.waitForEvent("page", { timeout: timeoutMs });
      await page.waitForURL(
        (url) => {
          const currentUrl = url.toString();
          return normalizeUrl(currentUrl) === normalizedTarget || currentUrl.startsWith(targetUrl);
        },
        { timeout: timeoutMs }
      );
    }

    process.stdout.write(`[human mode] ページ読み込み待機中...\n`);
    await page.waitForLoadState(waitUntil, { timeout: timeoutMs }).catch(() => {
      process.stdout.write(`[human mode] 読み込みタイムアウト。現在のDOMを取得します。\n`);
    });

    const finalUrl = page.url();
    const title = await page.title();
    process.stdout.write(`\n`);
    process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    process.stdout.write(`[human mode] 取得準備完了\n`);
    process.stdout.write(`  URL  : ${finalUrl}\n`);
    process.stdout.write(`  Title: ${title}\n`);
    process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let proceed = true;
    try {
      const answer = await rl.question(
        "このページのHTMLを取得してよいですか？ [Enter=OK / s=スキップ]: "
      );
      proceed = answer.trim().toLowerCase() !== "s";
    } finally {
      rl.close();
    }

    if (!proceed) {
      return { html: "", url: finalUrl, title, skipped: true };
    }

    const html = await page.content();
    process.stdout.write(`[human mode] 取得完了（${html.length.toLocaleString()} 文字）\n`);
    return { html, url: finalUrl, title, skipped: false };
  } finally {
    await browser.close().catch(() => {});
  }
}
