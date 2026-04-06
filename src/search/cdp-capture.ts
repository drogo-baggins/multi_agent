import { type Page } from "playwright-core";

import { getOrCreateBrowser, navigateTo, closeDedicatedTab } from "./cdp-session.js";

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

async function resetDedicatedTitle(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.title = "pi-agent-dedicated";
    })
    .catch(() => {
      void 0;
    });
}

async function removeCaptureOverlay(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.getElementById("__pi_agent_overlay__")?.remove();
    })
    .catch(() => {
      void 0;
    });
}

export async function capturePageWithCdp(
  targetUrl: string,
  options: CdpCaptureOptions = {
    onPromptReady: () => undefined
  }
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

  try {
    await page.evaluate((displayUrl) => {
      const existing = document.getElementById("__pi_agent_overlay__");
      existing?.remove();

      const overlay = document.createElement("div");
      overlay.id = "__pi_agent_overlay__";
      overlay.style.position = "fixed";
      overlay.style.top = "0";
      overlay.style.left = "0";
      overlay.style.right = "0";
      overlay.style.zIndex = "2147483647";
      overlay.style.background = "rgba(15, 23, 42, 0.96)";
      overlay.style.color = "#fff";
      overlay.style.padding = "24px";
      overlay.style.fontFamily = "system-ui, sans-serif";
      overlay.style.fontSize = "16px";
      overlay.style.boxShadow = "0 12px 40px rgba(0, 0, 0, 0.35)";
      overlay.style.backdropFilter = "blur(8px)";
      overlay.style.display = "flex";
      overlay.style.flexDirection = "column";
      overlay.style.gap = "12px";

      const title = document.createElement("div");
      title.textContent = "Human Mode: confirm capture in the browser";
      title.style.fontWeight = "700";
      title.style.fontSize = "18px";

      const urlLine = document.createElement("div");
      urlLine.textContent = displayUrl;
      urlLine.style.opacity = "0.9";
      urlLine.style.wordBreak = "break-all";

      const buttonRow = document.createElement("div");
      buttonRow.style.display = "flex";
      buttonRow.style.gap = "12px";

      const enterButton = document.createElement("button");
      enterButton.type = "button";
      enterButton.textContent = "✅ キャプチャして続行";
      enterButton.style.padding = "12px 18px";
      enterButton.style.borderRadius = "8px";
      enterButton.style.border = "0";
      enterButton.style.background = "#22c55e";
      enterButton.style.color = "#052e16";
      enterButton.style.cursor = "pointer";

      const skipButton = document.createElement("button");
      skipButton.type = "button";
      skipButton.textContent = "⏭ スキップ";
      skipButton.style.padding = "12px 18px";
      skipButton.style.borderRadius = "8px";
      skipButton.style.border = "1px solid rgba(255,255,255,0.25)";
      skipButton.style.background = "transparent";
      skipButton.style.color = "#fff";
      skipButton.style.cursor = "pointer";

      const setResult = (result: string) => {
        overlay.dataset.result = result;
      };

      enterButton.addEventListener("click", () => setResult("enter"));
      skipButton.addEventListener("click", () => setResult("skip"));

      buttonRow.append(enterButton, skipButton);
      overlay.append(title, urlLine, buttonRow);
      document.body.appendChild(overlay);
    }, urlDisplay);
  } catch {
    return { html: "", url: targetUrl, title: "", skipped: true, reason: "inject-failure" };
  }

  options.onPromptReady(`[human mode] ブラウザ上のボタンを押してください: ${urlDisplay}`);

  if (options.signal?.aborted) {
    await removeCaptureOverlay(page);
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
        void page
          .evaluate(() => {
            const overlay = document.getElementById("__pi_agent_overlay__");
            if (overlay) {
              overlay.dataset.result = "abort";
            }
          })
          .catch(() => {
            void 0;
          });
        resolve("aborted");
      },
      { once: true }
    );
  });

  const overlayResult = await Promise.race([
    page.waitForFunction(
      () => document.getElementById("__pi_agent_overlay__")?.dataset.result || "",
      { timeout: 0 }
    ),
    abortPromise
  ]);

  if (overlayResult === "aborted") {
    await removeCaptureOverlay(page);
    return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
  }

  const resolvedResult = await overlayResult.evaluate((result) => String(result || ""));
  if (resolvedResult === "abort") {
    await removeCaptureOverlay(page);
    return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
  }

  if (resolvedResult === "skip") {
    await removeCaptureOverlay(page);
    return { html: "", url: targetUrl, title: "", skipped: true, reason: "user-skip" };
  }

  if (options.signal?.aborted) {
    await removeCaptureOverlay(page);
    return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
  }

  await removeCaptureOverlay(page);

  await waitForCaptureReady(page, waitUntil, options.onPromptReady);

  if (options.signal?.aborted) {
    return { html: "", url: targetUrl, title: "", skipped: true, reason: "aborted" };
  }

  const finalUrl = page.url();
  const title = await page.title();
  const html = await page.content();
  await resetDedicatedTitle(page);

  return { html, url: finalUrl, title, skipped: false };
}

process.once("exit", () => {
  void closeDedicatedTab();
});
