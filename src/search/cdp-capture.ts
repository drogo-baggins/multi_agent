import { type Page } from "playwright-core";

import { getOrCreateOverlayTab, getOrCreateTargetTab, closeCaptureTabs, logHumanMode } from "./cdp-session.js";

export interface CdpCaptureOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
  signal?: AbortSignal;
  onPromptReady: (prompt: string) => void;
}

export type CdpCaptureSkipReason = "user-skip" | "inject-failure" | "aborted";

export interface CdpCaptureResult {
  html: string;
  url: string;
  title: string;
  skipped: boolean;
  reason?: CdpCaptureSkipReason;
}

async function waitForCaptureReady(
  page: Page,
  waitUntil: NonNullable<CdpCaptureOptions["waitUntil"]>,
  onPromptReady: (prompt: string) => void
): Promise<void> {
  await page.waitForLoadState(waitUntil, { timeout: 15_000 }).catch(() => {
    onPromptReady("[human mode] 読み込みタイムアウト。現在のDOMを取得します。");
  });
}

export async function capturePageWithCdp(
  targetUrl: string,
  options: CdpCaptureOptions = {
    onPromptReady: () => undefined
  }
): Promise<CdpCaptureResult> {
  const waitUntil = options.waitUntil ?? "domcontentloaded";

  if (options.signal?.aborted) {
    await logHumanMode("[capture] aborted before page acquisition");
    return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
  }

  const overlayPage = await getOrCreateOverlayTab();
  const targetPage = await getOrCreateTargetTab();

  await logHumanMode(`[capture] acquired overlay=${overlayPage.url()} target=${targetPage.url()} url=${targetUrl}`);

  const urlDisplay = targetUrl.length > 70 ? `${targetUrl.slice(0, 67)}...` : targetUrl;
  const injectOverlay = async (isInitial: boolean): Promise<void> => {
    await logHumanMode(`[capture] injecting overlay initial=${isInitial}`);

    const escapedTargetUrl = targetUrl
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");

    const overlayHtml = `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>pi-agent-overlay</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
        overflow: hidden;
        background: radial-gradient(circle at top, rgba(15, 23, 42, 0.98), rgba(2, 6, 23, 1));
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #fff;
      }
      body {
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
        box-sizing: border-box;
      }
      .panel {
        width: min(920px, 100%);
        box-sizing: border-box;
        background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.9));
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
        display: flex;
        flex-direction: column;
        gap: 16px;
      }
      .title {
        font-size: 20px;
        font-weight: 800;
        letter-spacing: 0.01em;
      }
      .hint {
        font-size: 14px;
        line-height: 1.7;
        color: rgba(255, 255, 255, 0.9);
      }
      .url {
        font-size: 13px;
        line-height: 1.6;
        word-break: break-all;
        color: rgba(255, 255, 255, 0.82);
        padding: 14px 16px;
        border-radius: 14px;
        background: rgba(255, 255, 255, 0.06);
        border: 1px solid rgba(255, 255, 255, 0.12);
      }
      .buttons {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
      }
      .enter,
      .skip {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        appearance: none;
        border-radius: 12px;
        padding: 14px 18px;
        font: inherit;
        font-weight: 700;
        text-decoration: none;
        transition: transform 120ms ease, opacity 120ms ease;
      }
      .enter {
        background: linear-gradient(180deg, #4ade80, #22c55e);
        color: #052e16;
      }
      .skip {
        background: rgba(255, 255, 255, 0.08);
        color: #fff;
        border: 1px solid rgba(255, 255, 255, 0.18);
      }
    </style>
  </head>
  <body>
    <main class="panel">
      <div class="title">pi-agent Human Mode</div>
      <div class="hint">調査対象ページは別ウィンドウに開いています。そちらを確認してから、下のボタンで続行します。</div>
      <div class="url">${escapedTargetUrl}</div>
      <div class="buttons">
        <a class="enter" href="about:blank?result=enter">✅ このページをキャプチャ</a>
        <a class="skip" href="about:blank?result=skip">⏭ スキップ</a>
      </div>
    </main>
  </body>
</html>`;

    await overlayPage.setContent(overlayHtml, { waitUntil: "load" });
    await logHumanMode(`[capture] overlay injected initial=${isInitial}`);
  };

  let overlayInjected = false;
  let promptShown = false;
  const framenavigatedHandler = (frame: Page["mainFrame"] extends () => infer MainFrame ? MainFrame : never): void => {
    void logHumanMode(`[capture] target navigated url=${frame.url()}`);
  };
  let navigationListenerAttached = false;

  try {
    await injectOverlay(true);
    overlayInjected = true;
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    await logHumanMode(`[capture] inject failed: ${message}`);
    return { html: "", url: targetUrl, title: "", skipped: true, reason: "inject-failure" };
  }

  try {
    targetPage.on("framenavigated", framenavigatedHandler);
    navigationListenerAttached = true;

    await logHumanMode(`[capture] navigating target to ${targetUrl}`);
    await targetPage.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await overlayPage.bringToFront().catch(() => {
      void 0;
    });

    options.onPromptReady(`[human mode] オーバーレイのボタンを押してください。調査対象URL: ${urlDisplay}`);
    promptShown = true;
    await logHumanMode("[capture] prompt ready");

    if (options.signal?.aborted) {
      await logHumanMode("[capture] aborted after prompt");
      return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
    }

    const abortPromise = new Promise<"aborted">((resolve) => {
      if (options.signal?.aborted) {
        resolve("aborted");
        return;
      }

      options.signal?.addEventListener(
        "abort",
        () => {
          void logHumanMode("[capture] abort signal received");
          resolve("aborted");
        },
        { once: true }
      );
    });

    const overlayResultPromise = overlayPage.waitForURL(
      (url) => {
        try {
          return new URL(url).searchParams.get("result") === "enter" || new URL(url).searchParams.get("result") === "skip";
        } catch {
          return false;
        }
      },
      { timeout: 0 }
    );

    const overlayResult = await Promise.race([overlayResultPromise, abortPromise]);

    if (overlayResult === "aborted") {
      await logHumanMode("[capture] aborted while waiting for overlay result");
      return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
    }

    const overlayUrl = overlayPage.url();
    const resolvedResult = new URL(overlayUrl).searchParams.get("result") || "";
    if (resolvedResult === "abort") {
      await logHumanMode("[capture] overlay aborted by result");
      return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
    }

    if (resolvedResult === "skip") {
      await logHumanMode("[capture] overlay skipped by user");
      return { html: "", url: targetUrl, title: "", skipped: true, reason: "user-skip" };
    }

    if (options.signal?.aborted) {
      await logHumanMode("[capture] aborted after overlay result");
      return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
    }

    await overlayPage.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {
      void 0;
    });
    await logHumanMode("[capture] overlay reset to blank");

    await waitForCaptureReady(targetPage, waitUntil, options.onPromptReady);
    await logHumanMode(`[capture] target ready url=${targetPage.url()}`);

    if (options.signal?.aborted) {
      await logHumanMode("[capture] aborted before DOM extraction");
      return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
    }

    const finalUrl = targetPage.url();
    const title = await targetPage.title();
    const html = await targetPage.content();
    await targetPage.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {
      void 0;
    });
    await logHumanMode(`[capture] extracted html length=${html.length} finalUrl=${finalUrl}`);

    return { html, url: finalUrl, title, skipped: false };
  } finally {
    if (navigationListenerAttached) {
      targetPage.off("framenavigated", framenavigatedHandler);
    }

    if (overlayInjected) {
      await overlayPage.goto("about:blank", { waitUntil: "domcontentloaded" }).catch(() => {
        void 0;
      });
      await logHumanMode(promptShown ? "[capture] overlay cleanup complete" : "[capture] overlay cleanup before prompt");
    }
  }
}

process.once("exit", () => {
  void closeCaptureTabs();
});
