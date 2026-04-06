import { chromium, type Browser, type Page } from "playwright-core";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { CDP_PORT, ensureChromeReady } from "./browser-launcher.js";

export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const OVERLAY_TITLE = "pi-agent-overlay";
const OVERLAY_WINDOW_NAME = "__pi_agent_overlay__";
const TARGET_TITLE = "pi-agent-target";
const TARGET_WINDOW_NAME = "__pi_agent_target__";

const DEDICATED_TITLE = OVERLAY_TITLE;
const DEDICATED_WINDOW_NAME = OVERLAY_WINDOW_NAME;

let browserPromise: Promise<Browser> | undefined;
let browserInstance: Browser | undefined;
let overlayPage: Page | undefined;
let targetPage: Page | undefined;
let dedicatedPage: Page | undefined;

const HUMAN_MODE_LOG_PATH = join(process.cwd(), "workspace", "output", "human-mode-debug.log");

export async function logHumanMode(message: string): Promise<void> {
  try {
    await mkdir(join(process.cwd(), "workspace", "output"), { recursive: true });
    await appendFile(HUMAN_MODE_LOG_PATH, `${new Date().toISOString()} ${message}\n`, "utf-8");
  } catch {
    void 0;
  }
}

function clearSessionState(): void {
  browserPromise = undefined;
  browserInstance = undefined;
  overlayPage = undefined;
  targetPage = undefined;
  dedicatedPage = undefined;
}

async function closePageSafely(page: Page | undefined): Promise<void> {
  if (page && !page.isClosed()) {
    await logHumanMode(`[close] closing page title=${await page.title().catch(() => "")}`);
    await page.close().catch(() => {
      void 0;
    });
  }
}

function trackPageClosure(page: Page): void {
  void logHumanMode(`[track] page tracked title=${page.url()}`);
  page.once("close", () => {
    if (overlayPage === page) {
      overlayPage = undefined;
    }
    if (targetPage === page) {
      targetPage = undefined;
    }
    if (dedicatedPage === page) {
      dedicatedPage = undefined;
    }
  });
}

function registerShutdownHook(): void {
  const globalState = globalThis as { __piAgentCdpShutdownRegistered?: boolean };
  if (globalState.__piAgentCdpShutdownRegistered) {
    return;
  }

  globalState.__piAgentCdpShutdownRegistered = true;
  process.once("exit", () => {
    try {
      void Promise.all([
        closePageSafely(overlayPage),
        closePageSafely(targetPage),
        closePageSafely(dedicatedPage)
      ]);
    } finally {
      clearSessionState();
    }
  });
}

async function connectBrowser(): Promise<Browser> {
  await logHumanMode("[browser] connecting over CDP");
  await ensureChromeReady(CDP_PORT);
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 10_000 });
  browser.on("disconnected", () => {
    void logHumanMode("[browser] disconnected");
    clearSessionState();
  });
  browserInstance = browser;
  await logHumanMode("[browser] connected over CDP");
  return browser;
}

export async function getOrCreateBrowser(): Promise<Browser> {
  registerShutdownHook();

  if (browserInstance?.isConnected()) {
    return browserInstance;
  }

  if (!browserPromise) {
    void logHumanMode("[browser] creating browser connection promise");
    browserPromise = connectBrowser();
  }

  browserInstance = await browserPromise;
  return browserInstance;
}

async function initializeOverlayTab(page: Page): Promise<Page> {
  await logHumanMode(`[overlay] initializing tab url=${page.url()}`);
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  dedicatedPage = page;
  overlayPage = page;
  await logHumanMode("[overlay] ready about:blank");
  return page;
}

async function initializeTargetTab(page: Page): Promise<Page> {
  await logHumanMode(`[target] initializing tab url=${page.url()}`);
  targetPage = page;
  await logHumanMode("[target] ready");
  return page;
}

/**
 * @deprecated Use getOrCreateOverlayTab() instead.
 */
export async function getOrCreateDedicatedTab(): Promise<Page> {
  return getOrCreateOverlayTab();
}

export async function getOrCreateOverlayTab(): Promise<Page> {
  const browser = await getOrCreateBrowser();

  if (overlayPage && !overlayPage.isClosed()) {
    await logHumanMode("[overlay] reusing cached page");
    return initializeOverlayTab(overlayPage);
  }

  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("[human mode] No browser context available for CDP session.");
  }

  const opener = await context.newPage();
  trackPageClosure(opener);
  await logHumanMode("[overlay] opening popup via window.open");

  const popupPromise = context.waitForEvent("page");
  await opener.evaluate(() => {
    const popup = window.open("about:blank", "_blank", "width=900,height=700,left=0,top=0");
    if (!popup) {
      throw new Error("[human mode] Failed to open overlay window.");
    }
  });

  const popup = await popupPromise;
  trackPageClosure(popup);
  await logHumanMode(`[overlay] popup created url=${popup.url()}`);

  await closePageSafely(opener);

  overlayPage = popup;
  dedicatedPage = popup;
  return initializeOverlayTab(popup);
}

export async function getOrCreateTargetTab(): Promise<Page> {
  const browser = await getOrCreateBrowser();

  if (targetPage && !targetPage.isClosed()) {
    await logHumanMode("[target] reusing cached page");
    return initializeTargetTab(targetPage);
  }

  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("[human mode] No browser context available for CDP session.");
  }

  const opener = await context.newPage();
  trackPageClosure(opener);
  await logHumanMode("[target] opening popup via window.open");

  const popupPromise = context.waitForEvent("page");
  await opener.evaluate(() => {
    const popup = window.open("about:blank", "_blank", "width=1200,height=900,left=120,top=80");
    if (!popup) {
      throw new Error("[human mode] Failed to open target window.");
    }
  });

  const popup = await popupPromise;
  trackPageClosure(popup);
  await logHumanMode(`[target] popup created url=${popup.url()}`);

  await closePageSafely(opener);

  targetPage = popup;
  return initializeTargetTab(popup);
}

export async function navigateTo(
  url: string,
  waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded"
): Promise<Page> {
  const page = await getOrCreateDedicatedTab();
  await page.goto(url, { waitUntil });
  await page.bringToFront().catch(() => {
    void 0;
  });
  return page;
}

/**
 * @deprecated Use getOrCreateOverlayTab() instead.
 */
export async function resetDedicatedTabToBlank(): Promise<Page> {
  const page = await getOrCreateDedicatedTab();
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });
  await page.bringToFront().catch(() => {
    void 0;
  });
  return page;
}

/**
 * @deprecated Use closeCaptureTabs() instead.
 */
export async function closeDedicatedTab(): Promise<void> {
  await closeCaptureTabs();
}

export async function closeCaptureTabs(): Promise<void> {
  await Promise.all([
    closePageSafely(overlayPage),
    closePageSafely(targetPage),
    closePageSafely(dedicatedPage)
  ]);
  clearSessionState();
}
