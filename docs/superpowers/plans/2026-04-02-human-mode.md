# 人力モード実装計画

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `SEARCH_MODE=human` 環境変数で起動時にモードを固定し、web_search / web_fetch を人力+CDP自動取得に差し替える

**Architecture:** 起動時に `loadSearchConfig()` でモードを読み取り、`createWorkerAgent()` でツール配列を切り替える。human モードでは Playwright `connectOverCDP` で専用 Chrome プロファイルに接続し、人間が操作した後の DOM を自動取得して既存の Readability+Turndown パイプラインに流す。

**Tech Stack:** playwright-core, Node.js child_process, readline, 既存の @mozilla/readability + linkedom + turndown

---

## 変更ファイル全体像

| # | ファイル | 新規/変更 | 責務 |
|---|---|---|---|
| 1 | `src/search/search-config.ts` | 変更 | `SearchMode` 型・`mode` フィールド追加 |
| 2 | `src/search/browser-launcher.ts` | **新規** | OS別Chrome起動（CDPポート付き）共通モジュール |
| 3 | `src/search/cdp-capture.ts` | **新規** | Playwright connectOverCDP でDOM自動取得 |
| 4 | `src/search/content-extractor.ts` | 変更 | `extractContentFromHtml(url, html)` 関数追加 |
| 5 | `src/tools/human-input-reader.ts` | **新規** | CLIでの複数行テキスト入力受付（human-search専用） |
| 6 | `src/tools/human-search-tool.ts` | **新規** | `web_search` の人力代替（ブラウザ起動+CDP取得） |
| 7 | `src/tools/human-fetch-tool.ts` | **新規** | `web_fetch` の人力代替（CDP自動DOM取得） |
| 8 | `src/agents/worker-agent.ts` | 変更 | `searchMode` でツール配列を切り替え |
| 9 | `src/index.ts` | 変更 | `searchConfig.mode` を Worker に渡す |
| 10 | `agents/worker/system.md` | 変更 | human モード用エラーハンドリングルール追記 |

---

## Chunk 1: 設定層（search-config.ts）

**Files:**
- Modify: `src/search/search-config.ts`
- Test: `src/search/search-config.test.ts`（既存テストがあれば更新、なければ新規）

### Task 1: SearchMode 型と mode フィールドの追加

- [ ] **Step 1: テスト作成**

`src/search/search-config.test.ts` に以下を追記（または新規作成）:

```typescript
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { loadSearchConfig } from "./search-config.js";

describe("loadSearchConfig – SEARCH_MODE", () => {
  let original: string | undefined;

  beforeEach(() => { original = process.env.SEARCH_MODE; });
  afterEach(() => {
    if (original === undefined) delete process.env.SEARCH_MODE;
    else process.env.SEARCH_MODE = original;
  });

  it("defaults to auto when SEARCH_MODE is unset", () => {
    delete process.env.SEARCH_MODE;
    assert.equal(loadSearchConfig().mode, "auto");
  });

  it("returns human when SEARCH_MODE=human", () => {
    process.env.SEARCH_MODE = "human";
    assert.equal(loadSearchConfig().mode, "human");
  });

  it("defaults to auto for unknown value", () => {
    process.env.SEARCH_MODE = "invalid";
    assert.equal(loadSearchConfig().mode, "auto");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm test -- --test-name-pattern "SEARCH_MODE"
```

Expected: fail（`mode` プロパティが存在しない）

- [ ] **Step 3: search-config.ts を変更**

```typescript
// 追加する型
export type SearchMode = "auto" | "human";

export interface SearchConfig {
  searxngUrl: string;
  timeoutMs: number;
  maxResults: number;
  userAgent: string;
  fallbackProviders: FallbackProvider[];
  tavilyApiKey?: string;
  braveApiKey?: string;
  serperApiKey?: string;
  mode: SearchMode;  // ← 追加
}

export function loadSearchConfig(): SearchConfig {
  const raw = process.env.SEARCH_FALLBACK_PROVIDERS ?? "";
  const fallbackProviders = raw
    .split(",")
    .map(s => s.trim())
    .filter((s): s is FallbackProvider => s === "tavily" || s === "brave" || s === "serper");

  const rawMode = process.env.SEARCH_MODE ?? "auto";
  const mode: SearchMode = rawMode === "human" ? "human" : "auto";  // ← 追加

  return {
    searxngUrl: process.env.SEARXNG_URL || "http://localhost:8888",
    timeoutMs: Number(process.env.SEARXNG_TIMEOUT_MS) || 30000,
    maxResults: Number(process.env.SEARXNG_MAX_RESULTS) || 10,
    userAgent: "pi-agent/1.0",
    fallbackProviders,
    tavilyApiKey: process.env.TAVILY_API_KEY,
    braveApiKey: process.env.BRAVE_API_KEY,
    serperApiKey: process.env.SERPER_API_KEY,
    mode  // ← 追加
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- --test-name-pattern "SEARCH_MODE"
```

Expected: PASS (3 tests)

- [ ] **Step 5: 型チェック**

```bash
npm run typecheck
```

Expected: エラーなし

- [ ] **Step 6: コミット**

```bash
git add src/search/search-config.ts src/search/search-config.test.ts
git commit -m "feat: add SearchMode type and mode field to SearchConfig"
```

---

## Chunk 2: ブラウザ起動モジュール（browser-launcher.ts）

**Files:**
- Create: `src/search/browser-launcher.ts`
- Test: `src/search/browser-launcher.test.ts`

### Task 2: OS別Chrome起動の共通モジュール

**設計要点:**
- Chrome を `--remote-debugging-port=9222 --user-data-dir=<専用パス>` で起動する
- `user-data-dir` はシステム一時ディレクトリ配下の固定パス（セッションをまたいで同じプロファイルを使うため）
- Chrome 136+ では `--user-data-dir` が必須（デフォルトプロファイルへの CDP は無効化された）
- ブラウザ起動失敗は致命的エラーにしない（手動起動案内を出す）
- 単純な URL を開く `openUrl(url)` も提供する（human-search で検索URL自動入力に使う）

- [ ] **Step 1: テスト作成**

```typescript
// src/search/browser-launcher.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildChromeArgs, getUserDataDir } from "./browser-launcher.js";

describe("browser-launcher", () => {
  it("includes remote-debugging-port in chrome args", () => {
    const args = buildChromeArgs();
    assert.ok(args.some(a => a.startsWith("--remote-debugging-port=")));
  });

  it("includes user-data-dir in chrome args", () => {
    const args = buildChromeArgs();
    assert.ok(args.some(a => a.startsWith("--user-data-dir=")));
  });

  it("getUserDataDir returns a non-empty string", () => {
    const dir = getUserDataDir();
    assert.ok(dir.length > 0);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm test -- --test-name-pattern "browser-launcher"
```

Expected: fail（ファイルが存在しない）

- [ ] **Step 3: browser-launcher.ts を作成**

```typescript
// src/search/browser-launcher.ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";

const execAsync = promisify(exec);

export const CDP_PORT = 9222;

/** pi-agent 専用の Chrome プロファイルディレクトリ */
export function getUserDataDir(): string {
  return join(tmpdir(), "pi-agent-chrome-profile");
}

/** Chrome 起動引数を組み立てる（テスト可能にするために分離） */
export function buildChromeArgs(): string[] {
  return [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${getUserDataDir()}`,
    "--no-first-run",
    "--no-default-browser-check",
  ];
}

/** OS 別の Chrome 実行ファイルパスを返す */
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

/**
 * pi-agent 専用プロファイルで Chrome を CDP 有効で起動する。
 * すでに起動済みの場合は失敗するが、エラーを throw しない（手動起動案内を出す）。
 */
export async function launchChromeWithCdp(): Promise<void> {
  const exe = getChromeExecutable();
  const args = buildChromeArgs().join(" ");
  const cmd =
    process.platform === "win32"
      ? `start "" "${exe}" ${args}`
      : `"${exe}" ${args} &`;

  try {
    await execAsync(cmd);
    // ブラウザが起動するまで少し待つ
    await new Promise(resolve => setTimeout(resolve, 1500));
  } catch {
    process.stderr.write(
      `[human mode] Chrome の自動起動に失敗しました。\n` +
      `手動で以下のコマンドで Chrome を起動してください:\n` +
      `  "${exe}" ${buildChromeArgs().join(" ")}\n`
    );
  }
}

/**
 * 既に起動済みの CDP 対応 Chrome で URL を開く。
 * connectOverCDP 接続前の「ページを開く」用途に使う。
 */
export async function openUrl(url: string): Promise<void> {
  // CDP 経由で新しいタブを開く（/json/new エンドポイント）
  try {
    await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent(url)}`);
  } catch {
    // CDP がまだ起動していない場合は OS コマンドで開く
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
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- --test-name-pattern "browser-launcher"
```

Expected: PASS (3 tests)

- [ ] **Step 5: 型チェック**

```bash
npm run typecheck
```

- [ ] **Step 6: コミット**

```bash
git add src/search/browser-launcher.ts src/search/browser-launcher.test.ts
git commit -m "feat: add browser-launcher for CDP-enabled Chrome startup"
```

---

## Chunk 3: CDP自動取得モジュール（cdp-capture.ts）

**Files:**
- Create: `src/search/cdp-capture.ts`
- Modify: `package.json`（playwright-core 追加）

**npm追加:**
```bash
npm install playwright-core
```

playwright-core はブラウザバイナリを同梱しない軽量版。既存のシステム Chrome に接続するため、バイナリダウンロード不要。

### Task 3: Playwright connectOverCDP でDOM自動取得

**設計要点:**
- `connectOverCDP("http://127.0.0.1:9222")` で専用 Chrome プロファイルに接続
- 指定 URL のタブが既に開いていれば即取得
- まだ開いていなければ `waitForEvent("page")` で人間が開くのを待つ
- ページが完全に読み込まれるまで `waitForLoadState("networkidle")` で待機
- 人間への確認プロンプト（「取得してよいですか？」）を挟む
- CLI に進捗を表示する

- [ ] **Step 1: playwright-core をインストール**

```bash
npm install playwright-core
npm run typecheck
```

Expected: 型チェックが通る

- [ ] **Step 2: テスト作成**（モック可能な純粋関数部分のみ）

```typescript
// src/search/cdp-capture.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "./cdp-capture.js";

describe("cdp-capture – normalizeUrl", () => {
  it("strips trailing slash for matching", () => {
    assert.equal(normalizeUrl("https://example.com/"), "https://example.com");
  });

  it("keeps path intact", () => {
    assert.equal(normalizeUrl("https://example.com/path"), "https://example.com/path");
  });
});
```

- [ ] **Step 3: テストが失敗することを確認**

```bash
npm test -- --test-name-pattern "cdp-capture"
```

- [ ] **Step 4: cdp-capture.ts を作成**

```typescript
// src/search/cdp-capture.ts
import { chromium } from "playwright-core";
import * as readline from "node:readline/promises";
import { CDP_PORT } from "./browser-launcher.js";

export const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

/** URL 末尾スラッシュ正規化（テスト可能な純粋関数） */
export function normalizeUrl(url: string): string {
  return url.replace(/\/$/, "");
}

export interface CdpCaptureOptions {
  /** 人間操作の待機タイムアウト（ミリ秒）。デフォルト 10 分 */
  timeoutMs?: number;
  /** ページ読み込み完了待機の戦略。デフォルト "networkidle" */
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

export interface CdpCaptureResult {
  html: string;
  url: string;
  title: string;
  skipped: boolean;
}

/**
 * CDP で接続済み Chrome から指定 URL のページ HTML を取得する。
 *
 * フロー:
 *   1. connectOverCDP で専用 Chrome に接続
 *   2. 指定 URL のタブが開いていれば即取得、なければ人間が開くのを待つ
 *   3. ページ読み込み完了を待機
 *   4. CLI で「取得してよいですか？」確認
 *   5. page.content() で HTML を返す
 */
export async function capturePageWithCdp(
  targetUrl: string,
  options: CdpCaptureOptions = {}
): Promise<CdpCaptureResult> {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const waitUntil = options.waitUntil ?? "networkidle";
  const normalizedTarget = normalizeUrl(targetUrl);

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 5000 });
  } catch {
    process.stderr.write(
      `[human mode] CDP に接続できません（ポート ${CDP_PORT}）。\n` +
      `Chrome が起動していない可能性があります。\n`
    );
    return { html: "", url: targetUrl, title: "", skipped: true };
  }

  try {
    const context = browser.contexts()[0];
    if (!context) {
      return { html: "", url: targetUrl, title: "", skipped: true };
    }

    // 既存タブの中から URL が一致するものを探す
    let page = context.pages().find(p => normalizeUrl(p.url()) === normalizedTarget);

    if (!page) {
      process.stdout.write(`\n[human mode] ${targetUrl} を開いてください...\n`);
      // 人間が開くのを待つ
      page = await context.waitForEvent("page", { timeout: timeoutMs });
      await page.waitForURL(
        url => normalizeUrl(url) === normalizedTarget || url.startsWith(targetUrl),
        { timeout: timeoutMs }
      );
    }

    // ページ読み込み完了まで待機
    process.stdout.write(`[human mode] ページ読み込み待機中...\n`);
    await page.waitForLoadState(waitUntil, { timeout: timeoutMs }).catch(() => {
      // networkidle タイムアウトは致命的ではない（SPAなど）
      process.stdout.write(`[human mode] 読み込みタイムアウト。現在のDOMを取得します。\n`);
    });

    // 人間への確認
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
      const answer = await rl.question("このページのHTMLを取得してよいですか？ [Enter=OK / s=スキップ]: ");
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
    // connectOverCDP の browser は close() せずに disconnect() するのが安全
    // （close() すると Chrome プロセス自体が終了する）
    await browser.close().catch(() => {});
  }
}
```

> **注意**: `browser.close()` を呼ぶと接続先の Chrome プロセスが終了する。Playwright の CDP 接続では `disconnect()` メソッドがないため、`close()` の呼び出しを避けるか、try-finally で飲み込む。詳細は [Playwright issue #6258](https://github.com/microsoft/playwright/issues/6258) を参照。

- [ ] **Step 5: テストが通ることを確認**

```bash
npm test -- --test-name-pattern "cdp-capture"
```

Expected: PASS (2 tests)

- [ ] **Step 6: 型チェック**

```bash
npm run typecheck
```

- [ ] **Step 7: コミット**

```bash
git add src/search/cdp-capture.ts src/search/cdp-capture.test.ts package.json package-lock.json
git commit -m "feat: add CDP page capture via Playwright connectOverCDP"
```

---

## Chunk 4: content-extractor.ts の拡張

**Files:**
- Modify: `src/search/content-extractor.ts`
- Test: `src/search/content-extractor.test.ts`（既存テストに追記）

### Task 4: extractContentFromHtml() の追加

**設計要点:**
- 既存の `extractContent(url)` は HTTP GET + Readability + Turndown のフル実装
- 新規の `extractContentFromHtml(url, html)` は HTTP GET をスキップして HTML 文字列を直接受け取る
- 戻り値の型 `ExtractedContent` は共通（Workerのプロンプトに影響しない）
- CDP または将来の他手段からも使えるように汎用的に設計

- [ ] **Step 1: テスト作成**

```typescript
// 既存の content-extractor.test.ts に追記（またはそのファイルの末尾に追加）
import { extractContentFromHtml } from "./content-extractor.js";

describe("extractContentFromHtml", () => {
  it("extracts title and content from HTML string", () => {
    const html = `
      <html><head><title>Test Page</title></head>
      <body><article><p>Hello World</p></article></body></html>
    `;
    const result = extractContentFromHtml("https://example.com", html);
    assert.equal(result.url, "https://example.com");
    assert.ok(result.title.length > 0 || result.content.includes("Hello"));
    assert.equal(result.error, undefined);
  });

  it("returns error when HTML has no extractable content", () => {
    const result = extractContentFromHtml("https://example.com", "<html></html>");
    assert.ok(result.error !== undefined);
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm test -- --test-name-pattern "extractContentFromHtml"
```

- [ ] **Step 3: content-extractor.ts に関数を追加**

既存ファイルの末尾に追記（既存コードは一切変更しない）:

```typescript
/**
 * HTML 文字列から readable markdown を抽出する。
 * CDP / Playwright など HTTP GET を経由しない取得手段と組み合わせて使う。
 * 戻り値の型は extractContent() と同一。
 */
export function extractContentFromHtml(url: string, html: string): ExtractedContent {
  try {
    const { document } = parseHTML(html);
    const article = new Readability(document).parse();
    if (!article?.content) {
      return { url, title: "", content: "", error: "Could not extract content" };
    }
    return {
      url,
      title: article.title || "",
      content: turndown.turndown(article.content),
      byline: article.byline || undefined,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { url, title: "", content: "", error: message };
  }
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- --test-name-pattern "extractContentFromHtml"
npm test  # 既存テストが壊れていないことを確認
```

- [ ] **Step 5: 型チェック**

```bash
npm run typecheck
```

- [ ] **Step 6: コミット**

```bash
git add src/search/content-extractor.ts src/search/content-extractor.test.ts
git commit -m "feat: add extractContentFromHtml for CDP/non-HTTP content sources"
```

---

## Chunk 5: 人力ツール実装（human-search / human-fetch）

**Files:**
- Create: `src/tools/human-input-reader.ts`
- Create: `src/tools/human-search-tool.ts`
- Create: `src/tools/human-fetch-tool.ts`

### Task 5: human-input-reader.ts（human-search 専用）

human-fetch は CDP で自動取得するため、複数行テキスト入力は **human-search のみ** に使う。

- [ ] **Step 1: テスト作成**

```typescript
// src/tools/human-input-reader.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTerminator } from "./human-input-reader.js";

describe("human-input-reader – parseTerminator", () => {
  it("detects END terminator", () => {
    assert.equal(parseTerminator("END"), "end");
  });

  it("detects SKIP terminator", () => {
    assert.equal(parseTerminator("SKIP"), "skip");
  });

  it("returns null for normal input", () => {
    assert.equal(parseTerminator("hello world"), null);
  });

  it("is case insensitive", () => {
    assert.equal(parseTerminator("end"), "end");
    assert.equal(parseTerminator("skip"), "skip");
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm test -- --test-name-pattern "human-input-reader"
```

- [ ] **Step 3: human-input-reader.ts を作成**

```typescript
// src/tools/human-input-reader.ts
import * as readline from "node:readline";

/** テスト可能な純粋関数: 行の終端コマンドを判定 */
export function parseTerminator(line: string): "end" | "skip" | null {
  const trimmed = line.trim().toLowerCase();
  if (trimmed === "end") return "end";
  if (trimmed === "skip") return "skip";
  return null;
}

export interface ReadMultilineOptions {
  timeoutMs?: number;
}

/**
 * CLIで複数行テキストを受け取る。
 * 終端: 単独行 "END" または Ctrl+D (EOF)
 * スキップ: 単独行 "SKIP" → null を返す
 * タイムアウト: null を返す（throw しない）
 */
export async function readMultilineInput(
  prompt: string,
  options: ReadMultilineOptions = {}
): Promise<string | null> {
  return new Promise(resolve => {
    const lines: string[] = [];
    let timer: NodeJS.Timeout | undefined;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    process.stdout.write(prompt + "\n");
    process.stdout.write('（入力後、単独行に "END" と入力するか Ctrl+D で確定。"SKIP" でスキップ）\n');

    function finish(result: string | null): void {
      if (timer !== undefined) clearTimeout(timer);
      rl.close();
      resolve(result);
    }

    rl.on("line", (line: string) => {
      const cmd = parseTerminator(line);
      if (cmd === "skip") { finish(null); return; }
      if (cmd === "end") { finish(lines.join("\n")); return; }
      lines.push(line);
    });

    rl.on("close", () => {
      finish(lines.length > 0 ? lines.join("\n") : null);
    });

    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        process.stdout.write("\n[human mode] タイムアウトしました。スキップします。\n");
        finish(null);
      }, options.timeoutMs);
    }
  });
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- --test-name-pattern "human-input-reader"
```

- [ ] **Step 5: コミット**

```bash
git add src/tools/human-input-reader.ts src/tools/human-input-reader.test.ts
git commit -m "feat: add human-input-reader for CLI multiline text input"
```

---

### Task 6: human-search-tool.ts

**設計要点:**
- ツール名は `"web_search"` と同一（Worker の system.md を変更不要にするため）
- 検索クエリを URL エンコードして Google / SearXNG の検索 URL を組み立て、ブラウザで自動起動
- 検索ボタンは人間が押す（サイト側から 100% 人間アクセスに見せる要件）
- 検索結果ページは CDP で自動取得（人間のコピペ不要）

- [ ] **Step 1: テスト作成**

```typescript
// src/tools/human-search-tool.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildSearchUrl } from "./human-search-tool.js";

describe("human-search-tool – buildSearchUrl", () => {
  it("uses Google when SEARXNG_URL is not set", () => {
    const original = process.env.SEARXNG_URL;
    delete process.env.SEARXNG_URL;
    const url = buildSearchUrl("TypeScript async");
    assert.ok(url.includes("google.com/search"));
    assert.ok(url.includes("TypeScript"));
    if (original !== undefined) process.env.SEARXNG_URL = original;
  });

  it("uses SearXNG when SEARXNG_URL is set", () => {
    const original = process.env.SEARXNG_URL;
    process.env.SEARXNG_URL = "http://localhost:8888";
    const url = buildSearchUrl("TypeScript async");
    assert.ok(url.includes("localhost:8888"));
    if (original !== undefined) process.env.SEARXNG_URL = original;
    else delete process.env.SEARXNG_URL;
  });

  it("URL-encodes the query", () => {
    const url = buildSearchUrl("hello world");
    assert.ok(url.includes("hello%20world") || url.includes("hello+world"));
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm test -- --test-name-pattern "human-search-tool"
```

- [ ] **Step 3: human-search-tool.ts を作成**

```typescript
// src/tools/human-search-tool.ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { openUrl } from "../search/browser-launcher.js";
import { capturePageWithCdp } from "../search/cdp-capture.js";
import { extractContentFromHtml } from "../search/content-extractor.js";

const MAX_CONTENT_CHARS = 30000;

/** テスト可能な純粋関数: 検索 URL を組み立てる */
export function buildSearchUrl(query: string): string {
  const encoded = encodeURIComponent(query);
  const searxngUrl = process.env.SEARXNG_URL ?? "";
  if (searxngUrl) {
    return `${searxngUrl.replace(/\/$/, "")}/search?q=${encoded}&format=html`;
  }
  return `https://www.google.com/search?q=${encoded}`;
}

const HumanSearchParametersSchema = Type.Object({
  query: Type.String(),
  maxResults: Type.Optional(Type.Number()),
});

type HumanSearchParameters = Static<typeof HumanSearchParametersSchema>;

export function createHumanSearchTool(): AgentTool<typeof HumanSearchParametersSchema> {
  return {
    name: "web_search", // ← web_search と同名にすることで Worker 側の変更不要
    label: "Web Search (Human-assisted)",
    description:
      "Searches the web. Opens a browser with the query pre-filled; " +
      "the human presses the search button, then the result page is captured automatically.",
    parameters: HumanSearchParametersSchema,
    async execute(_toolCallId: string, params: HumanSearchParameters, _signal?: AbortSignal) {
      const searchUrl = buildSearchUrl(params.query);

      // 1. 検索 URL をブラウザで開く（クエリ自動入力済みの状態）
      process.stdout.write(`\n`);
      process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.stdout.write(`[human mode] 検索クエリ: ${params.query}\n`);
      process.stdout.write(`[human mode] ブラウザで検索ページを開きます...\n`);
      process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      await openUrl(searchUrl);

      process.stdout.write(`[human mode] 検索ボタンを押してください。\n`);
      process.stdout.write(`[human mode] 結果ページが読み込まれたら自動で取得します。\n`);

      // 2. CDP で検索結果ページを自動取得
      //    URL プレフィックスで待機（検索後のリダイレクト先も捕捉）
      const result = await capturePageWithCdp(searchUrl, {
        timeoutMs: 5 * 60 * 1000,
        waitUntil: "domcontentloaded", // 検索結果ページは networkidle が来ない場合がある
      });

      if (result.skipped || result.html === "") {
        return {
          content: [
            {
              type: "text",
              text: `No results provided for "${params.query}". Skipped by user or timed out.`,
            },
          ],
          details: { query: params.query, resultCount: 0, results: [], skipped: true },
        };
      }

      // 3. Readability + Turndown で本文抽出
      const extracted = extractContentFromHtml(result.url, result.html);
      const truncated = extracted.content.length > MAX_CONTENT_CHARS;
      const body = truncated
        ? `${extracted.content.slice(0, MAX_CONTENT_CHARS)}\n\n[Content truncated...]`
        : extracted.content;

      const formattedMarkdown = [
        `**Search query**: ${params.query}`,
        `**Source**: ${result.url}`,
        "",
        body,
      ].join("\n");

      return {
        content: [{ type: "text", text: formattedMarkdown }],
        details: {
          query: params.query,
          resultCount: 1,
          results: [{ url: result.url, content: extracted.content }],
        },
      };
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- --test-name-pattern "human-search-tool"
```

- [ ] **Step 5: 型チェック**

```bash
npm run typecheck
```

- [ ] **Step 6: コミット**

```bash
git add src/tools/human-search-tool.ts src/tools/human-search-tool.test.ts
git commit -m "feat: add human-search-tool with CDP auto-capture"
```

---

### Task 7: human-fetch-tool.ts

**設計要点:**
- ツール名は `"web_fetch"` と同一
- `browser-launcher.openUrl()` でページを開く → CDP で DOM 自動取得 → `extractContentFromHtml()` で Markdown 変換
- 出力フォーマット（`# タイトル\nSource: URL\n\n本文`）を `web_fetch` と完全に一致させる
- コピペ入力は不要（CDP で完全自動化）

- [ ] **Step 1: テスト作成**

```typescript
// src/tools/human-fetch-tool.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatFetchResult } from "./human-fetch-tool.js";

describe("human-fetch-tool – formatFetchResult", () => {
  it("formats output identical to web_fetch", () => {
    const result = formatFetchResult("https://example.com", "Test Title", "Hello World");
    assert.ok(result.startsWith("# Test Title\n"));
    assert.ok(result.includes("Source: https://example.com"));
    assert.ok(result.includes("Hello World"));
  });

  it("truncates content over MAX_CONTENT_CHARS", () => {
    const long = "x".repeat(35000);
    const result = formatFetchResult("https://example.com", "T", long);
    assert.ok(result.includes("[Content truncated...]"));
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm test -- --test-name-pattern "human-fetch-tool"
```

- [ ] **Step 3: human-fetch-tool.ts を作成**

```typescript
// src/tools/human-fetch-tool.ts
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";
import { openUrl } from "../search/browser-launcher.js";
import { capturePageWithCdp } from "../search/cdp-capture.js";
import { extractContentFromHtml } from "../search/content-extractor.js";

const MAX_CONTENT_CHARS = 30000;

/** テスト可能な純粋関数: web_fetch と同一フォーマットで本文を整形 */
export function formatFetchResult(url: string, title: string, content: string): string {
  const truncated = content.length > MAX_CONTENT_CHARS;
  const body = truncated
    ? `${content.slice(0, MAX_CONTENT_CHARS)}\n\n[Content truncated...]`
    : content;
  return `# ${title}\nSource: ${url}\n\n${body}`;
}

const HumanFetchParametersSchema = Type.Object({
  url: Type.String(),
});

type HumanFetchParameters = Static<typeof HumanFetchParametersSchema>;

export function createHumanFetchTool(): AgentTool<typeof HumanFetchParametersSchema> {
  return {
    name: "web_fetch", // ← web_fetch と同名にすることで Worker 側の変更不要
    label: "Web Fetch (Human-assisted)",
    description:
      "Fetches a web page. Opens the URL in a browser for human interaction " +
      "(login, CAPTCHA, etc.), then captures the page DOM automatically.",
    parameters: HumanFetchParametersSchema,
    async execute(_toolCallId: string, params: HumanFetchParameters, _signal?: AbortSignal) {
      // 1. ブラウザでURLを開く
      process.stdout.write(`\n`);
      process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      process.stdout.write(`[human mode] 取得URL: ${params.url}\n`);
      process.stdout.write(`[human mode] ブラウザでページを開きます...\n`);
      process.stdout.write(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      await openUrl(params.url);

      process.stdout.write(`[human mode] ページ操作が完了したら Enter を押してください。\n`);
      process.stdout.write(`            （ログイン・CAPTCHA 解除後でも待機します）\n`);

      // 2. CDP でページを自動取得
      const result = await capturePageWithCdp(params.url, {
        timeoutMs: 10 * 60 * 1000,
        waitUntil: "networkidle",
      });

      if (result.skipped || result.html === "") {
        return {
          content: [
            {
              type: "text",
              text: `Failed to fetch ${params.url}: skipped by user or timed out.`,
            },
          ],
          details: { url: params.url, error: "skipped" },
        };
      }

      // 3. Readability + Turndown で本文抽出
      const extracted = extractContentFromHtml(result.url, result.html);

      if (extracted.error) {
        return {
          content: [{ type: "text", text: `Failed to fetch ${params.url}: ${extracted.error}` }],
          details: { url: params.url, error: extracted.error },
        };
      }

      // 4. web_fetch と同一フォーマットで返す
      const title = extracted.title || result.title || "Untitled";
      const formattedContent = formatFetchResult(result.url, title, extracted.content);

      return {
        content: [{ type: "text", text: formattedContent }],
        details: {
          url: result.url,
          title,
          truncated: extracted.content.length > MAX_CONTENT_CHARS,
          contentLength: extracted.content.length,
        },
      };
    },
  };
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- --test-name-pattern "human-fetch-tool"
```

- [ ] **Step 5: 型チェック**

```bash
npm run typecheck
```

- [ ] **Step 6: コミット**

```bash
git add src/tools/human-fetch-tool.ts src/tools/human-fetch-tool.test.ts
git commit -m "feat: add human-fetch-tool with CDP auto-capture"
```

---

## Chunk 6: ツール配線（worker-agent.ts / index.ts）

**Files:**
- Modify: `src/agents/worker-agent.ts`
- Modify: `src/index.ts`

### Task 8: worker-agent.ts の searchMode 対応

- [ ] **Step 1: テスト作成**

```typescript
// src/agents/worker-agent.test.ts の既存テストに追記（またはテスト確認）
// createWorkerAgent が human モードで human_search/human_fetch を含むことを確認
// ※ 実際のAgent生成はモデルが必要なため、ツール配列の組み立てロジックを
//   pure function として分離しておくと単体テストしやすい

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildWorkerTools } from "./worker-agent.js";

describe("worker-agent – buildWorkerTools", () => {
  it("returns web_search and web_fetch in auto mode", () => {
    const tools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "auto" });
    const names = tools.map(t => t.name);
    assert.ok(names.includes("web_search"));
    assert.ok(names.includes("web_fetch"));
  });

  it("returns web_search and web_fetch also in human mode (same names)", () => {
    // human モードでもツール名は同じ（実装が差し替わる）
    const tools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "human" });
    const names = tools.map(t => t.name);
    assert.ok(names.includes("web_search"));
    assert.ok(names.includes("web_fetch"));
  });

  it("uses human label in human mode", () => {
    const tools = buildWorkerTools({ sandboxDir: "/tmp", searchMode: "human" });
    const webSearch = tools.find(t => t.name === "web_search");
    assert.ok(webSearch?.label?.includes("Human"));
  });
});
```

- [ ] **Step 2: テストが失敗することを確認**

```bash
npm test -- --test-name-pattern "buildWorkerTools"
```

- [ ] **Step 3: worker-agent.ts を変更**

```typescript
// src/agents/worker-agent.ts（全体）
import { Agent, type StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { Model } from "@mariozechner/pi-ai";

import { loadAgentConfig } from "../config/index.js";
import { createSandboxedTools } from "../tools/sandboxed-tools.js";
import { createWebSearchTool } from "../tools/web-search-tool.js";
import { createWebFetchTool } from "../tools/web-fetch-tool.js";
import { createHumanSearchTool } from "../tools/human-search-tool.js";
import { createHumanFetchTool } from "../tools/human-fetch-tool.js";
import type { SearchMode } from "../search/search-config.js";

export interface WorkerAgentOptions {
  configDir: string;
  sandboxDir: string;
  model?: Model<any>;
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  searchMode?: SearchMode; // ← 追加（省略時は "auto" 相当）
}

/** テスト可能な純粋関数: searchMode に応じたウェブツール配列を返す */
export function buildWorkerTools(options: Pick<WorkerAgentOptions, "sandboxDir" | "searchMode">) {
  const webTools =
    options.searchMode === "human"
      ? [createHumanSearchTool(), createHumanFetchTool()]
      : [createWebSearchTool(), createWebFetchTool()];
  return [...createSandboxedTools(options.sandboxDir), ...webTools];
}

export async function createWorkerAgent(options: WorkerAgentOptions): Promise<Agent> {
  const systemPrompt = await loadAgentConfig(options.configDir);

  if (!options.model) {
    throw new Error("WorkerAgent requires a model. Pass the session model via options.model.");
  }

  const agent = new Agent({
    initialState: { systemPrompt, model: options.model },
    streamFn: options.streamFn ?? streamSimple,
    getApiKey: options.getApiKey,
  });

  agent.setTools(buildWorkerTools(options));
  return agent;
}
```

- [ ] **Step 4: テストが通ることを確認**

```bash
npm test -- --test-name-pattern "buildWorkerTools"
npm test  # 全テスト
```

- [ ] **Step 5: 型チェック**

```bash
npm run typecheck
```

- [ ] **Step 6: コミット**

```bash
git add src/agents/worker-agent.ts src/agents/worker-agent.test.ts
git commit -m "feat: add searchMode option to WorkerAgent for human/auto tool switching"
```

---

### Task 9: index.ts の searchMode 配線

- [ ] **Step 1: index.ts を変更**

差分は2箇所のみ（`import` 追加と `searchMode` 追加）:

```typescript
// src/index.ts（変更箇所のみ）

// ① import に追加
import { loadSearchConfig } from "./search/search-config.js";

// ② main() 内、loadEnvFile() の直後に追加
const searchConfig = loadSearchConfig();

// ③ registry.register("worker", ...) 内の createWorkerAgent 呼び出しに追加
return createWorkerAgent({
  configDir: workerConfigDir,
  sandboxDir,
  model: resolveAgentModel("worker", session.model, session.modelRegistry),
  getApiKey,
  searchMode: searchConfig.mode,  // ← 追加
});
```

- [ ] **Step 2: 型チェック**

```bash
npm run typecheck
```

Expected: エラーなし

- [ ] **Step 3: 全テスト**

```bash
npm test
```

Expected: 既存テストが壊れていないこと

- [ ] **Step 4: コミット**

```bash
git add src/index.ts
git commit -m "feat: wire searchMode from env to WorkerAgent"
```

---

## Chunk 7: Chrome起動フローの統合・system.md 更新

**Files:**
- Modify: `src/search/cdp-capture.ts`（Chrome 未起動時の自動起動を追加）
- Modify: `agents/worker/system.md`

### Task 10: Chrome 未起動時の自動起動を cdp-capture に追加

現在の `cdp-capture.ts` は CDP に接続できなければ `skipped: true` を返す。
human モードでは Chrome を自動起動してから接続を試みる方が UX がよい。

- [ ] **Step 1: cdp-capture.ts の接続失敗時に Chrome を自動起動するよう修正**

```typescript
// src/search/cdp-capture.ts の capturePageWithCdp() 冒頭を変更

import { launchChromeWithCdp } from "./browser-launcher.js"; // ← import 追加

// 接続試行 → 失敗したら Chrome 起動 → 再試行
let browser;
try {
  browser = await chromium.connectOverCDP(CDP_ENDPOINT, { timeout: 3000 });
} catch {
  // Chrome が起動していなければ自動起動して再試行
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
```

- [ ] **Step 2: 型チェック・テスト**

```bash
npm run typecheck
npm test
```

- [ ] **Step 3: コミット**

```bash
git add src/search/cdp-capture.ts
git commit -m "feat: auto-launch Chrome when CDP connection fails in human mode"
```

---

### Task 11: agents/worker/system.md の更新

- [ ] **Step 1: system.md のエラーハンドリングセクションを更新**

`agents/worker/system.md` の「エラーハンドリング」セクション末尾に以下を追記:

```markdown
### 人力モード（human mode）固有のエラーハンドリング
- `web_search` または `web_fetch` が "skipped by user or timed out" を返した場合:
  - 同じ URL / クエリで再度呼び出さない（ユーザーがスキップした意図を尊重する）
  - 別のクエリや別の URL で代替を試みる
  - 代替が見つからない場合は、その旨を `output/progress.md` に記録して次のサブタスクに進む
- 人力モードではページ取得に時間がかかる場合がある。
  取得できなかった情報は「調査の制限事項」セクションに明記してレポートを完成させること
```

- [ ] **Step 2: コミット**

```bash
git add agents/worker/system.md
git commit -m "docs: add human mode error handling rules to worker system.md"
```

---

## Chunk 8: .env.example と README 更新

**Files:**
- Modify: `.env.example`（または `.env` の該当箇所）

### Task 12: .env.example に SEARCH_MODE を追記

- [ ] **Step 1: .env.example（または README の設定例）に追記**

```bash
# Web取得モード: auto（自動）または human（人力+CDP自動取得）
# human モードでは web_search / web_fetch の代わりに
# ブラウザを起動して人間が操作し、DOM を自動取得する
# デフォルト: auto
# SEARCH_MODE=human
```

- [ ] **Step 2: コミット**

```bash
git add .env.example
git commit -m "docs: add SEARCH_MODE to .env.example"
```

---

## 処理フロー（改訂版）

### auto モード（変更なし）

```
Worker → web_search(query)
  → searchWeb() → SearXNG / フォールバック API
  → URL リスト返却

Worker → web_fetch(url)
  → extractContent(url) → HTTP GET → Readability → Turndown → Markdown
```

### human モード（CDP統合後）

```
Worker → web_search(query)       ← ツール名は同じ
  → buildSearchUrl(query)        ← Google / SearXNG URL 組み立て
  → openUrl(searchUrl)           ← CDP /json/new でブラウザにタブを開く
  → CLI: "検索ボタンを押してください"
  [人間] 検索ボタンを1クリック
  → capturePageWithCdp(searchUrl)
      → connectOverCDP(localhost:9222)
      → waitForEvent("page") / 既存タブ検索
      → waitForLoadState("domcontentloaded")
      → CLI: "このページのHTMLを取得してよいですか？ [Enter=OK]"
      [人間] Enter キー1回
      → page.content() で HTML 取得
  → extractContentFromHtml(url, html)  ← 既存 Readability + Turndown
  → AgentToolResult 返却（web_search と同一フォーマット）

Worker → web_fetch(url)          ← ツール名は同じ
  → openUrl(url)                 ← ブラウザでページを開く
  → CLI: "ページ操作が完了したら Enter を押してください（ログイン等）"
  [人間] ログイン / CAPTCHA 等の操作、完了後 Enter
  → capturePageWithCdp(url)      ← 上記と同フロー
  → extractContentFromHtml(url, html)
  → AgentToolResult 返却（web_fetch と同一フォーマット）
```

### 人間の操作量（比較）

| 操作 | コピペ方式（旧案） | CDP方式（本実装） |
|---|---|---|
| 検索結果を取得 | ボタンクリック + Ctrl+A + Ctrl+C + ペースト + "END" | ボタン1クリック + Enter1回 |
| ページを取得 | Ctrl+A + Ctrl+C + ペースト + "END" | Enter1回（操作が必要な場合のみ操作） |

---

## スコープ外と将来の拡張ポイント

### 今回スコープ外

| 項目 | 将来の対応方針 |
|---|---|
| CLI 起動引数でのモード指定 | `process.argv` を解析して `searchConfig.mode` を上書き（`src/index.ts` のみ変更） |
| Chrome拡張 + webhookによる1クリック送信 | `capturePageWithCdp()` の代替として `capturePageWithExtension()` を同じインターフェースで追加 |
| ループ中の動的モード切り替え | `registry.evict("worker")` 後の再生成時に `searchMode` を更新（`LoopIntegrationOptions` に追加） |
| Firefox 対応 | WebDriver BiDi（`webdriverio` パッケージ）で同等の DOM 取得が可能 |
| `auto_first`（自動失敗→人力フォールバック） | `SearchMode` に `"auto_first"` を追加し、`buildWorkerTools()` でフォールバック付きラッパーを返す |

### 拡張ポイント一覧

| 変更内容 | 変更ファイル |
|---|---|
| タイムアウト時間の環境変数化 | `src/search/search-config.ts` に `humanSearchTimeoutMs` 等を追加 |
| CDP ポート番号の設定化 | `browser-launcher.ts` の `CDP_PORT` を `SEARCH_CDP_PORT` 環境変数から読む |
| Chrome 実行ファイルパスの設定化 | `browser-launcher.ts` の `getChromeExecutable()` を `CHROME_PATH` 環境変数対応に |
| ページ取得の確認プロンプトをスキップ | `cdp-capture.ts` の `CdpCaptureOptions` に `skipConfirmation?: boolean` を追加 |
