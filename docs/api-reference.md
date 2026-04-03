# API Reference

## モジュール構成

```
src/
  config/       設定ファイルの読み込み・初期化
  communication/ エージェント間通信基盤
  agents/       エージェントファクトリ
  tools/        エージェントツール定義
  loop/         永続実行ループ
  search/       Web検索・コンテンツ取得
  index.ts      CLIエントリーポイント
```

---

## search

### `SearchConfig`

`search-config.ts`

```typescript
type FallbackProvider = "tavily" | "brave" | "serper";

type SearchMode = "auto" | "human";

interface SearchConfig {
  mode: SearchMode;             // 起動時固定モード (env: SEARCH_MODE)
  searxngUrl: string;           // SearXNG エンドポイント
  timeoutMs: number;            // リクエストタイムアウト (ms)
  maxResults: number;           // 返す結果の最大数
  userAgent: string;            // HTTP User-Agent ヘッダー
  fallbackProviders: FallbackProvider[]; // SearXNG失敗時の試行順プロバイダー
  tavilyApiKey?: string;        // Tavily API キー
  braveApiKey?: string;         // Brave Search API キー
  serperApiKey?: string;        // Serper API キー
}
```

### `loadSearchConfig(): SearchConfig`

環境変数から設定を読み込む。

| 環境変数 | デフォルト | 説明 |
|---|---|---|
| `SEARXNG_URL` | `http://localhost:8888` | SearXNG エンドポイント |
| `SEARXNG_TIMEOUT_MS` | `30000` | リクエストタイムアウト (ms) |
| `SEARXNG_MAX_RESULTS` | `10` | 最大結果数 |
| `SEARCH_FALLBACK_PROVIDERS` | `""` (なし) | フォールバックプロバイダー（カンマ区切り）例: `"tavily,brave"` |
| `TAVILY_API_KEY` | — | Tavily API キー |
| `BRAVE_API_KEY` | — | Brave Search API キー |
| `SERPER_API_KEY` | — | Serper API キー |
| `SEARCH_MODE` | `auto` | 検索モード: `auto`（自動）または `human`（人力+CDP） |
| `ITERATION_TIMEOUT_MS` | `600000` | 1イテレーションあたりのタイムアウト (ms)。`SEARCH_MODE=human` では人間操作の待機時間があるため `3600000`（1時間）以上を推奨 |

### `searchWeb(query, options?): Promise<SearchResponse>`

`searxng-client.ts`

SearXNG に検索クエリを投げ、失敗した場合は `fallbackProviders` を順次試行する。

```typescript
interface SearchResponse {
  results: SearchResult[];
  query: string;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedDate?: string;
  engine?: string;  // SearXNG時はエンジン名、フォールバック時は "tavily" | "brave" | "serper"
}
```

**フォールバック動作:**
- SearXNG がエラー（HTTP非200・ネットワーク障害）を返すと、`fallbackProviders` を順番に試行
- APIキーが未設定のプロバイダーはスキップ
- すべて失敗した場合は SearXNG のエラーメッセージで throw

**オプション:**
```typescript
{
  limit?: number;         // 取得件数を上書き
  config?: SearchConfig;  // テスト等で設定を注入する場合
}
```

### `searchTavily(query, options): Promise<SearchResult[]>`

### `searchBrave(query, options): Promise<SearchResult[]>`

### `searchSerper(query, options): Promise<SearchResult[]>`

`fallback-client.ts`

各プロバイダーへの直接呼び出し。`searchWeb` のフォールバックとして内部使用するが、直接呼び出しも可能。

```typescript
interface FallbackOptions {
  apiKey: string;
  maxResults?: number;  // デフォルト: 10
  timeoutMs?: number;   // デフォルト: 30000
}
```

### Human Mode モジュール

#### `browser-launcher.ts`

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `getUserDataDir()` | `(): string` | pi-agent専用Chromeプロファイルのパスを返す（tmpdir配下）。通常Chromeと独立 |
| `buildChromeArgs()` | `(): string[]` | CDP起動引数配列を返す（`--remote-debugging-port`・`--user-data-dir` など） |
| `waitForCdpReady(port?, deadlineMs?)` | `(): Promise<string>` | `/json/version` を300ms間隔でポーリングし、`webSocketDebuggerUrl` が取れたら返す。タイムアウト時はthrow |
| `launchChromeWithCdp()` | `(): Promise<void>` | OSコマンドでChromeをCDP付きで起動。失敗時はstderrに手動起動コマンドを出力 |
| `ensureChromeReady(port?, launchIfNeeded?)` | `(): Promise<string>` | CDPが既に応答していればそのWS URLを返す。未応答なら`launchChromeWithCdp`を呼び出し再ポーリング |
| `openUrlAndGetTargetId(url, port?)` | `(): Promise<string \| undefined>` | CDP `/json/new` で新タブを開き、そのタブのターゲットIDを返す。CDPが未応答の場合はOSのデフォルトブラウザで開き `undefined` を返す |
| `getWsUrlForTargetId(targetId, port?)` | `(): Promise<string \| undefined>` | CDP `/json/list` からターゲットIDに対応する `webSocketDebuggerUrl` を返す。見つからない場合は `undefined` |

#### `capturePageWithCdp(url, options?)` — `cdp-capture.ts`

```typescript
interface CdpCaptureOptions {
  waitUntil?: "load" | "domcontentloaded" | "networkidle";
}

interface CdpCaptureResult {
  html: string;
  url: string;
  title: string;
  skipped: boolean;
}

async function capturePageWithCdp(
  targetUrl: string,
  options?: CdpCaptureOptions
): Promise<CdpCaptureResult>
```

**処理フロー:**
1. `ensureChromeReady` でCDPの準備を確認（未起動なら自動起動）
2. `openUrlAndGetTargetId` で対象URLを新タブで開き、ターゲットIDを取得
3. Playwright `connectOverCDP` で接続
4. ユーザーが Enter を押すまで待機（ログイン・CAPTCHA等の人間操作を許容）
5. `getWsUrlForTargetId` でターゲットIDからWS URLを特定し、URL一致でページを直接選択
   - ターゲットIDが不明な場合はURLスコアリングでフォールバック選択
6. DOM取得 → `CdpCaptureResult` を返す

ユーザーがスキップした場合または取得失敗時は `skipped: true`。

#### `extractContentFromHtml(html, url)` — `content-extractor.ts`

HTML文字列からMarkdownテキストを抽出する。HTTP fetchを行わないCDP専用版。

```typescript
function extractContentFromHtml(
  url: string,
  html: string
): { content: string; title: string; error?: string }
```

---

## config

### `loadAgentConfig(agentDir: string, skills?: string[]): Promise<string>`

`config-loader.ts`

指定ディレクトリからMarkdown設定ファイルを読み込み、systemPrompt文字列を構築する。

**組み立て順序**: `agent.md` → `system.md` → `skills/*.md` → `APPEND_SYSTEM.md`

- 存在しないファイルはスキップ
- `skills` を指定した場合、そのファイル名のみを読み込み（未指定時は全 `*.md`）
- 各ファイルは `\n\n` で結合

```typescript
const systemPrompt = await loadAgentConfig("./agents/worker");
const filtered = await loadAgentConfig("./agents/worker", ["research.md"]);
```

### `initializeAgentConfig(agentDir: string, agentName: string): Promise<void>`

`config-initializer.ts`

エージェント設定ディレクトリをテンプレートファイル付きで作成する。

作成されるファイル: `agent.md`, `system.md`, `APPEND_SYSTEM.md`, `skills/`, `backups/`

---

## communication

### `AgentRegistry`

`agent-registry.ts`

エージェントインスタンスの遅延初期化・キャッシュ・ライフサイクル管理。

```typescript
const registry = new AgentRegistry();

registry.register("worker", async () => {
  const agent = await createWorkerAgent({ ... });
  agent.getApiKey = getApiKey;
  return agent;
});

const worker = await registry.get("worker");  // 初回: ファクトリ実行、以降: キャッシュ
```

#### メソッド

| メソッド | 説明 |
|---|---|
| `register(name: string, factory: () => Promise<Agent>)` | ファクトリ関数を登録 |
| `has(name: string): boolean` | 登録済みか確認 |
| `get(name: string): Promise<Agent>` | インスタンスを取得（遅延初期化、in-flight重複排除） |
| `getInitializedNames(): string[]` | 初期化済みエージェント名の一覧 |
| `evict(name: string): void` | インスタンスを破棄（`reset()` 呼び出し + キャッシュ削除）。次回 `get()` で再作成される |
| `shutdownAll(): void` | 全インスタンスを `reset()` |

### `invokeAgent(agent: Agent, message: string): Promise<AgentToolResult<void>>`

`invoke-agent.ts`

エージェントの `prompt()` を呼び出し、最終AssistantMessageからテキストを抽出して `AgentToolResult` 形式で返す。エラー発生時は `isError: true` 付きの結果を返す。

```typescript
const result = await invokeAgent(workerAgent, "調査タスク");
// result.content[0].text に応答テキスト
```

### `extractTextFromMessages(messages: AgentMessage[]): string`

`invoke-agent.ts`

メッセージ配列からAssistantMessageのテキストブロックのみを抽出して結合。

### `relayEvents(childAgent: Agent, onUpdate: (event: AgentEvent) => void): () => void`

`event-relay.ts`

子エージェントのイベントを親のコールバックに中継する。戻り値は購読解除関数。

---

## agents

### `createWorkerAgent(options: WorkerAgentOptions): Promise<Agent>`

`worker-agent.ts`

```typescript
interface WorkerAgentOptions {
  configDir: string;       // agents/worker/ ディレクトリパス
  sandboxDir: string;      // workspace/ ディレクトリパス
  model?: Model<any>;      // デフォルト: claude-sonnet-4-20250514
  streamFn?: StreamFn;     // デフォルト: streamSimple
  searchMode?: SearchMode; // デフォルト: "auto"。"human" 指定時は human tools を使用
}
```

Worker Agentを作成。設定ファイルからsystemPromptを構築し、サンドボックス化ツール + Web検索ツールを装備。

### `buildWorkerTools(options: WorkerAgentOptions): ToolDefinition[]`

`worker-agent.ts`

`searchMode` に応じて適切なツール一式を返すファクトリ。

| `searchMode` | `web_search` | `web_fetch` |
|---|---|---|
| `"auto"` (デフォルト) | SearXNG + フォールバック | HTTP fetch |
| `"human"` | `createHumanSearchTool` | `createHumanFetchTool` |

### `createManagerAgent(options: ManagerAgentOptions): Promise<Agent>`

`manager-agent.ts`

```typescript
interface ManagerAgentOptions {
  configDir: string;        // agents/manager/ ディレクトリパス
  workerConfigDir: string;  // agents/worker/ ディレクトリパス
  sandboxDir: string;       // workspace/ ディレクトリパス
  model?: Model<any>;
  streamFn?: StreamFn;
}
```

Manager Agentを作成。5つの管理ツール（`read_worker_config`, `read_work_product`, `update_worker_config`, `evaluate_work_product`, `read_changelog`）を装備。

### `createProxyAgent(options: ProxyAgentOptions): Promise<Agent>`

`proxy-agent.ts`

```typescript
interface ProxyAgentOptions {
  configDir: string;        // agents/proxy/ ディレクトリパス
  registry: AgentRegistry;  // Worker/Manager取得用
  model?: Model<any>;
  streamFn?: StreamFn;
}
```

Proxy Agentを作成。統一実行ツール（`start_research_loop`）+ `ask_user` ツールを装備。

---

## tools

### Proxy Tools (`tool-definitions.ts`)

#### `createCustomToolDefinitions(options: CustomToolsOptions): ToolDefinition[]`
Proxy Agent用のカスタムツール一式を生成する。

```typescript
interface CustomToolsOptions {
  registry: AgentRegistry;
  workerConfigDir: string;
  logsDir?: string;
}
```

生成されるツール:
- `start_research_loop` — Worker→Manager評価ループの起動。すべてのタスクはこのツールを通して実行される
- `ask_user` — ユーザーへの質問・確認
- `web_search` — Web検索
- `web_fetch` — Webページ取得

#### `start_research_loop`
永続実行ループを起動する。パラメータ: `{ task: string, maxIterations?: number, qualityThreshold?: number }`

#### `ask_user`
ユーザーに質問するツール。パラメータ: `{ question: string }`

### Manager Tools (`manager-tools.ts`)

#### `createReadWorkerConfigTool(workerConfigDir: string): AgentTool`
Worker設定ファイル群（agent.md, system.md, skills/*, APPEND_SYSTEM.md）を一括読み取り。パラメータ: なし。

#### `createReadWorkProductTool(workerSandboxDir: string): AgentTool`
`output/` ディレクトリのファイル一覧取得または特定ファイル読み取り。パラメータ: `{ filename?: string }`

#### `createUpdateWorkerConfigTool(workerConfigDir: string): AgentTool`
APPEND_SYSTEM.mdを更新。バックアップ作成 + changelog追記。

パラメータ:
```typescript
{
  content: string;        // 新しいAPPEND_SYSTEM.md内容
  reason: string;         // 変更理由
  hypothesis: string;     // 改善仮説
  expectedEffect: string; // 期待される効果
  llmModel: string;       // 使用中のLLMモデル
}
```

#### `createEvaluateWorkProductTool(workerSandboxDir: string): AgentTool`
成果物ファイルの内容 + 構造化評価フレームワークを返す。パラメータ: `{ filename: string }`

#### `createReadChangelogTool(workerConfigDir: string): AgentTool`
changelog.mdの内容を返す。パラメータ: なし。

### Worker Tools

#### `createWebSearchTool(): AgentTool`
Web検索ツール（v1ではスタブ実装）。パラメータ: `{ query: string, maxResults?: number }`

#### `createSandboxedTools(sandboxDir: string): AgentTool[]`
PI toolkitの `createCodingTools` / `createBashTool` をサンドボックスディレクトリにスコープして返す。

### Human Mode Tools (`human-search-tool.ts`, `human-fetch-tool.ts`)

`SEARCH_MODE=human` 時に `web_search` / `web_fetch` の代替として使用されるツール群。

#### `createHumanSearchTool(): AgentTool`

`web_search` の人力代替ツール。パラメータ: `{ query: string, maxResults?: number }`

動作フロー:
1. ターミナルに検索語を表示
2. `capturePageWithCdp` が検索URL（Google等）を新タブで開き、ターゲットIDを取得
3. ユーザーがブラウザで検索実行（ログイン・CAPTCHA等も人間が処理）
4. Enter を押すと CDP でDOM自動取得
5. 取得HTMLを `extractContentFromHtml` でMarkdownに変換して返す

#### `createHumanFetchTool(): AgentTool`

`web_fetch` の人力代替ツール。パラメータ: `{ url: string }`

動作フロー:
1. ターミナルに対象URLを表示
2. `capturePageWithCdp` が対象URLを新タブで開き、ターゲットIDを取得
3. ユーザーがページを操作（ログイン・CAPTCHA等）
4. Enter を押すと CDP でDOM自動取得（ターゲットIDで正確なタブを特定）
5. 取得HTMLを `extractContentFromHtml` でMarkdownに変換して返す

---

## loop

### `runPersistenceLoop(task: string, callbacks: LoopCallbacks, config?: Partial<LoopConfig>): Promise<IterationResult[]>`

`persistence-loop.ts`

永続実行ループを実行する。コールバック駆動で外部依存なし。

```typescript
interface LoopConfig {
  maxIterations: number;       // デフォルト: 10
  iterationTimeoutMs: number;  // デフォルト: 600,000 (10分)。env: ITERATION_TIMEOUT_MS で上書き可能。human mode では 3,600,000 (1時間) 以上を推奨
}
```

**戻り値**: 各イテレーションの結果配列

```typescript
interface IterationResult {
  iteration: number;
  workProduct: string;
  evaluation: EvaluationReport;
  improvements: string[];
  latencyMs: LatencyRecord;
  outcome: "user-approved" | "improvement-applied" | "max-iterations" | "user-interrupted" | "timeout";
}

interface LatencyRecord {
  workerExecutionMs: number;
  evaluationMs: number;
  managerImprovementMs: number;
  totalMs: number;
}
```

### `LoopCallbacks`

`persistence-loop.ts`

```typescript
interface LoopCallbacks {
  executeWorker(task: string): Promise<string>;
  evaluateProduct(workProduct: string): Promise<EvaluationReport>;
  getUserFeedback(workProduct: string, evaluation: EvaluationReport, iteration: number): Promise<UserFeedback>;
  executeImprovement(requests: ImprovementRequest[]): Promise<string[]>;
  onIterationComplete(result: IterationResult): void;
  readCurrentConfig(): Promise<string>;
}

type UserFeedback =
  | { type: "approved" }
  | { type: "improve"; feedback: string }
  | { type: "interrupt" };
```

### `LoopStatusReporter`

`loop-integration.ts`

ループの各フェーズ移行を受け取るコールバックインターフェース。`LoopIntegrationOptions.statusReporter` に渡すことでフェーズ別に通知を受け取れる。

`start_research_loop` ツールはTUI実行時（`ctx.hasUI === true`）に自動で `ctx.ui.setStatus("loop", ...)` / `ctx.ui.setWorkingMessage()` を呼ぶ実装をバンドルしている。

```typescript
export interface LoopStatusReporter {
  onWorkerStart(iteration: number, maxIterations: number): void;
  onEvaluationStart(iteration: number, maxIterations: number): void;
  onFeedbackWaiting(iteration: number, maxIterations: number, score: number): void;
  onImprovementStart(iteration: number, maxIterations: number): void;
  onLoopComplete(totalIterations: number, finalScore: number): void;
  onLoopInterrupted(iteration: number): void;
}
```

### `createLoopCallbacks(options: LoopIntegrationOptions): LoopCallbacks`

`loop-integration.ts`

抽象コールバックの具体実装を生成するファクトリ。Worker/Manager Agentの呼び出し、ユーザー対話、設定読み込みを結線する。

```typescript
interface LoopIntegrationOptions {
  registry: AgentRegistry;
  workerConfigDir: string;
  ui: UserInteraction;
  logsDir?: string;
  task?: string;
  qualityThreshold?: number;
  onIterationReport?: (report: string) => void;
  auditLogger?: AuditLogger;
  maxIterations?: number;          // ステータス表示用の最大イテレーション数（デフォルト: 10）
  statusReporter?: LoopStatusReporter; // フェーズ別ステータス更新コールバック
}
```

### 構造化評価 (`evaluation-report.ts`)

#### `formatEvaluationReport(report: EvaluationReport): string`
EvaluationReportをMarkdown文字列にフォーマット。

#### `parseEvaluationReport(text: string): EvaluationReport`
Markdown文字列をEvaluationReportにパース。正規表現ベースの寛容パーサー。

#### 型定義

```typescript
type IssueCause = "config" | "task-difficulty" | "llm-limitation";
type IssueCategory = "coverage" | "accuracy" | "structure" | "citations" | "other";

interface EvaluationIssue {
  category: IssueCategory;
  description: string;
  evidence: string;
  cause: IssueCause;
}

interface EvaluationReport {
  qualityScore: number;  // 0-100
  issues: EvaluationIssue[];
  summary: string;
}
```

### 構造化改善要求 (`improvement-request.ts`)

#### `formatImprovementRequest(request: ImprovementRequest): string`
ImprovementRequestをMarkdown文字列にフォーマット。

#### `buildImprovementRequests(report: EvaluationReport, workProduct: string, currentConfig: string, userFeedback: string): ImprovementRequest[]`
EvaluationReportの `cause: "config"` 課題からImprovementRequest配列を構築。

#### 型定義

```typescript
interface ImprovementRequest {
  issueCategory: IssueCategory;
  issueEvidence: string;
  workProductExcerpt: string;
  relatedConfigSection: string;
  improvementDirection: string;
  userFeedback: string;
}
```

### 停滞検出 (`stagnation-detector.ts`)

#### `detectStagnation(results: IterationResult[], config?: Partial<StagnationConfig>): StagnationResult`

```typescript
interface StagnationConfig {
  windowSize: number;              // デフォルト: 3
  minImprovementThreshold: number; // デフォルト: 2
}

interface StagnationResult {
  isStagnant: boolean;
  consecutiveNonImprovements: number;
  scoreTrend: number[];
  recommendation: string;
}
```

### レイテンシ監視 (`latency-tracker.ts`)

#### `summarizeLatency(results: IterationResult[], targetIterationMs: number): LatencySummary`

```typescript
interface LatencySummary {
  iterationCount: number;
  averageTotalMs: number;
  averageWorkerMs: number;
  averageEvaluationMs: number;
  averageManagerMs: number;
  bottleneck: "worker" | "evaluation" | "manager";
  trend: "increasing" | "decreasing" | "stable";
  exceedsTarget: boolean;
  targetMs: number;
}
```

### ロールバック判定 (`rollback-manager.ts`)

#### `evaluateRollback(results: IterationResult[], config?: Partial<RollbackConfig>): RollbackDecision`

```typescript
interface RollbackConfig {
  consecutiveDegradationThreshold: number; // デフォルト: 3
}

interface RollbackDecision {
  shouldRollback: boolean;
  consecutiveDegradations: number;
  lastGoodIteration: number | null;
  reason: string;
}
```
