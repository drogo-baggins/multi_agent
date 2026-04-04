import { chromium, type Browser, type Page } from "playwright-core";

import { CDP_PORT, ensureChromeReady } from "./browser-launcher.js";

export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;
const DEDICATED_TITLE = "pi-agent-dedicated";

let browserPromise: Promise<Browser> | undefined;
let browserInstance: Browser | undefined;
let dedicatedPage: Page | undefined;

function clearSessionState(): void {
  browserPromise = undefined;
  browserInstance = undefined;
  dedicatedPage = undefined;
}

function registerShutdownHook(): void {
  const globalState = globalThis as { __piAgentCdpShutdownRegistered?: boolean };
  if (globalState.__piAgentCdpShutdownRegistered) {
    return;
  }

  globalState.__piAgentCdpShutdownRegistered = true;
  process.once("exit", () => {
    try {
      dedicatedPage?.close().catch(() => {
        void 0;
      });
    } finally {
      clearSessionState();
    }
  });
}

async function connectBrowser(): Promise<Browser> {
  await ensureChromeReady(CDP_PORT);
  const browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 10_000 });
  browser.on("disconnected", () => {
    clearSessionState();
  });
  browserInstance = browser;
  return browser;
}

export async function getOrCreateBrowser(): Promise<Browser> {
  registerShutdownHook();

  if (browserInstance?.isConnected()) {
    return browserInstance;
  }

  if (!browserPromise) {
    browserPromise = connectBrowser();
  }

  browserInstance = await browserPromise;
  return browserInstance;
}

async function markDedicatedTab(page: Page): Promise<void> {
  await page
    .evaluate(title => {
      document.title = title;
    }, DEDICATED_TITLE)
    .catch(() => {
      void 0;
    });
}

async function findDedicatedPage(browser: Browser): Promise<Page | undefined> {
  const context = browser.contexts()[0];
  if (!context) {
    return undefined;
  }

  for (const page of context.pages()) {
    try {
      if ((await page.title()) === DEDICATED_TITLE) {
        return page;
      }
    } catch {
      void 0;
    }
  }

  return undefined;
}

export async function getOrCreateDedicatedTab(): Promise<Page> {
  const browser = await getOrCreateBrowser();

  if (dedicatedPage && !dedicatedPage.isClosed()) {
    return dedicatedPage;
  }

  const found = await findDedicatedPage(browser);
  if (found && !found.isClosed()) {
    dedicatedPage = found;
    return found;
  }

  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("[human mode] No browser context available for CDP session.");
  }

  const page = await context.newPage();
  await page.goto("about:blank");
  await markDedicatedTab(page);
  dedicatedPage = page;
  return page;
}

export async function navigateTo(
  url: string,
  waitUntil: "load" | "domcontentloaded" | "networkidle" = "domcontentloaded"
): Promise<Page> {
  const page = await getOrCreateDedicatedTab();
  await page.goto(url, { waitUntil });
  return page;
}

export async function closeDedicatedTab(): Promise<void> {
  const page = dedicatedPage;
  dedicatedPage = undefined;

  if (page && !page.isClosed()) {
    await page.close().catch(() => {
      void 0;
    });
  }

  clearSessionState();
}
