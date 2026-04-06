#!/usr/bin/env tsx
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getOrCreateBrowser, navigateTo } from "../src/search/cdp-session.js";
import { ensureChromeReady } from "../src/search/browser-launcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUTPUT_DIR = join(ROOT, "workspace", "output");
const SCREENSHOT_PATH = join(OUTPUT_DIR, "human-overlay-poc.png");

async function main(): Promise<void> {
  await mkdir(OUTPUT_DIR, { recursive: true });

  console.log("=== Human Mode Overlay POC ===");
  console.log("This runs outside the main app flow.");
  console.log("It opens a blank Chrome page, injects the overlay directly, and saves a screenshot.");

  await ensureChromeReady();
  await getOrCreateBrowser();

  const page = await navigateTo("about:blank", "domcontentloaded");

  await page.evaluate(() => {
    document.title = "Human Mode POC";

    const host = document.createElement("div");
    host.id = "__pi_agent_overlay_host__";
    host.style.position = "fixed";
    host.style.inset = "0";
    host.style.zIndex = "2147483647";

    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>
        :host {
          all: initial;
          position: fixed;
          inset: 0;
          z-index: 2147483647;
        }
        .backdrop {
          position: fixed;
          inset: 0;
          background: rgba(2, 6, 23, 0.75);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        .panel {
          width: min(900px, calc(100vw - 48px));
          background: linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(15, 23, 42, 0.94));
          border: 1px solid rgba(255, 255, 255, 0.16);
          border-radius: 24px;
          padding: 28px;
          color: white;
          box-shadow: 0 24px 80px rgba(0, 0, 0, 0.45);
        }
        .title {
          font-size: 24px;
          font-weight: 800;
          margin-bottom: 12px;
        }
        .body {
          font-size: 16px;
          line-height: 1.7;
          opacity: 0.95;
          margin-bottom: 20px;
        }
        .buttons {
          display: flex;
          gap: 12px;
          flex-wrap: wrap;
        }
        button {
          appearance: none;
          border: 0;
          border-radius: 12px;
          padding: 14px 18px;
          font: inherit;
          font-weight: 700;
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
      <div class="backdrop">
        <div class="panel" role="dialog" aria-modal="true" aria-label="Human Mode capture controls">
          <div class="title">Human Mode: confirm capture in the browser</div>
          <div class="body">
            This is the standalone proof-of-concept overlay.
            If you can see this panel, the browser UI path is working independently of the main app.
          </div>
          <div class="buttons">
            <button class="enter" type="button">✅ キャプチャして続行</button>
            <button class="skip" type="button">⏭ スキップ</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(host);
  });

  await page.bringToFront().catch(() => undefined);
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });

  console.log(`Overlay screenshot saved to: ${SCREENSHOT_PATH}`);
  console.log("Open the screenshot to verify the overlay, or switch to the Chrome window that was brought to front.");
  console.log("This POC intentionally does not use the worker path.");

  await writeFile(join(OUTPUT_DIR, "human-overlay-poc.txt"), [
    "Human overlay POC completed.",
    `Screenshot: ${SCREENSHOT_PATH}`,
    "If the screenshot is visible, the overlay rendered correctly."
  ].join("\n") + "\n", "utf-8");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});