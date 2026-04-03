import { chromium, type Page } from "playwright-core";
import * as readline from "node:readline/promises";
import { CDP_PORT, ensureChromeReady } from "./browser-launcher.js";

export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

export function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export interface CdpCaptureOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface CdpCaptureResult {
  html: string;
  url: string;
  title: string;
  skipped: boolean;
}

export function scorePageForUrl(pageUrl: string, targetUrl: string): number {
  const norm = normalizeUrl(pageUrl);
  const target = normalizeUrl(targetUrl);
  if (norm === target) return 3;
  if (norm.startsWith(target) || target.startsWith(norm)) return 2;
  if (!pageUrl.startsWith("chrome://") && !pageUrl.startsWith("about:")) return 1;
  return 0;
}

async function waitForUserEnter(prompt: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function selectPage(
  pages: Page[],
  targetUrl: string
): Promise<{ page: Page | undefined; skipped: boolean }> {
  if (pages.length === 0) {
    return { page: undefined, skipped: true };
  }

  const scored = pages
    .map(p => ({ page: p, score: scorePageForUrl(p.url(), targetUrl) }))
    .sort((a, b) => b.score - a.score);

  if (scored[0].score >= 2) {
    return { page: scored[0].page, skipped: false };
  }

  process.stdout.write(`[human mode] 開いているページ:\n`);
  scored.forEach((s, i) => {
    process.stdout.write(`  [${i + 1}] ${s.page.url()}\n`);
  });

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let chosen: Page | undefined;
  try {
    const answer = await rl.question(
      `取得するページ番号を入力してください [1-${scored.length} / Enter=1 / s=スキップ]: `
    );
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "s") return { page: undefined, skipped: true };
    const idx = parseInt(trimmed || "1", 10) - 1;
    chosen = scored[Math.min(Math.max(idx, 0), scored.length - 1)].page;
  } finally {
    rl.close();
  }

  return { page: chosen, skipped: false };
}

export async function capturePageWithCdp(
  targetUrl: string,
  options: CdpCaptureOptions = {}
): Promise<CdpCaptureResult> {
  const waitUntil = options.waitUntil ?? "networkidle";

  let wsUrl: string;
  try {
    wsUrl = await ensureChromeReady(CDP_PORT);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return { html: "", url: targetUrl, title: "", skipped: true };
  }

  const browser = await chromium.connectOverCDP(wsUrl, { timeout: 10_000 });

  try {
    const context = browser.contexts()[0];
    if (!context) {
      return { html: "", url: targetUrl, title: "", skipped: true };
    }

    await waitForUserEnter(
      `[human mode] ${targetUrl} を開いたら Enter を押してください: `
    );

    const pages = context.pages();
    const { page, skipped } = await selectPage(pages, targetUrl);

    if (skipped || !page) {
      return { html: "", url: targetUrl, title: "", skipped: true };
    }

    await page.waitForLoadState(waitUntil, { timeout: 15_000 }).catch(() => {
      process.stdout.write(`[human mode] 読み込みタイムアウト。現在のDOMを取得します。\n`);
    });

    const finalUrl = page.url();
    const title = await page.title();
    const html = await page.content();
    process.stdout.write(`[human mode] 取得完了: ${title} (${html.length.toLocaleString()} 文字)\n`);
    return { html, url: finalUrl, title, skipped: false };
  } finally {
    browser.close().catch(() => { void 0; });
  }
}

