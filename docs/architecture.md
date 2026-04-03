# Architecture Guide

## システム全体像

pi-agentは3層のエージェントアーキテクチャで構成される。各エージェントはPI toolkitの `Agent` クラスの独立したインスタンスとして動作し、カスタムToolを通じて相互通信する。

```
┌─────────────────────────────────────────────────────┐
│                      User (CLI REPL)                │
│                         │                           │
│                    ┌────▼────┐                       │
│                    │  Proxy  │                       │
│                    │  Agent  │                       │
│                    └────┬────┘                       │
│                         │                           │
│                  start_research_loop                 │
│                         │                           │
│              ┌──────────┼──────────┐                │
│              │                     │                │
│        ┌─────▼─────┐        ┌─────▼──────┐         │
│        │  Worker    │        │  Manager   │         │
│        │  Agent     │◄──────►│  Agent     │         │
│        │ (sandbox)  │  評価   │            │         │
│        └─────┬──────┘  改善   └─────┬──────┘         │
│              │                     │                │
│         workspace/           agents/worker/         │
│         output/*.md          APPEND_SYSTEM.md       │
│                              changelog.md           │
│                              backups/               │
└─────────────────────────────────────────────────────┘
```

## 設計判断

### Decision 1: Agent classの直接使用

各エージェントを独立した `Agent` インスタンスとして構成。`createAgentSession` ではなく `Agent` classを直接使用する。

**理由**: Agentクラスはtool定義・実行ループ・イベントストリームを提供し、各エージェントの責務を明確に分離できる。セッション永続化は現時点で不要。

### Decision 2: 統一実行パスによるルーティング

すべてのユーザーリクエストは `start_research_loop` を通して実行される。Proxy Agentはタスクの規模に応じてパラメータ（`qualityThreshold`、`maxIterations`）を調整する。

**理由**: 以前の `route_to_worker`（直接Worker呼び出し）と `route_to_manager`（直接Manager呼び出し）の2経路方式では、`route_to_worker` を通ったタスクがManagerの品質評価・監査ログ・タイムアウト保護を一切受けられない問題があった。単一の実行パスに統一することで、すべてのタスクが同じ品質保証・安全機構の恩恵を受ける。

### Decision 3: Markdown設定ファイルシステム

| ファイル | 役割 | 変更権限 |
|---|---|---|
| `agent.md` | ペルソナ・基本方針 | 人間のみ |
| `system.md` | タスク実行ルール | 人間のみ |
| `skills/*.md` | スキル定義 | 人間のみ |
| `APPEND_SYSTEM.md` | 動的追加指示 | Manager Agent |

systemPromptは `agent.md → system.md → skills/*.md → APPEND_SYSTEM.md` の順で結合される。Manager Agentの変更範囲を `APPEND_SYSTEM.md` に限定することで、コア設定の破壊を防止する。

### Decision 4: サンドボックス化

PI toolkitの `createCodingTools` / `createBashTool` を使用し、Worker Agentのファイルアクセスを `workspace/` ディレクトリに制限。v1ではファイルシステムスコープのみ（Docker化はv2）。

### Decision 5: 仮説駆動の改善サイクル

Manager Agentの `update_worker_config` ツールは以下を必須パラメータとする:
- `content`: 新しいAPPEND_SYSTEM.md内容
- `reason`: 変更理由
- `hypothesis`: 何がどう改善するかの仮説
- `expectedEffect`: 期待される効果
- `llmModel`: 使用中のLLMモデル

すべての変更は `changelog.md` に構造化記録され、次回の改善サイクルで参照可能。

### Decision 6: ToolResult経由の通信

Proxy Agentのカスタムツール内で子エージェントの `prompt()` を await し、結果を `ToolResult` として返す。追加の通信レイヤーは不要。

### Decision 7: コールバック駆動の永続実行ループ

永続実行ループ（`runPersistenceLoop`）は純粋なコールバックインターフェース（`LoopCallbacks`）で設計。PI toolkitへの直接依存はゼロ。

**理由**: テスタビリティ。モックコールバックで全ループロジック（タイムアウト、イテレーション管理、終了条件）をLLM呼び出しなしでテスト可能。

### Decision 8: 汎用性保証原則

設計・実装・テストにおいて、特定のタスクドメインやテストシナリオに結合したロジックを禁止する。

**禁止**: ハードコード検証条件、ドメイン特化if分岐、テスト合格目的の条件分岐

**許容**: タスク非依存のパイプライン、設定ファイルによるパラメータ化、LLM判断への委任

### Decision 9: Human Mode — CDPによる人力最小化

クローラーブロック・CAPTCHA・ログイン必須コンテンツへの対策として、`SEARCH_MODE=human` モードを追加。目的は人力を完全排除することではなく、**人間の操作を限界まで最小化**することにある。

**アーキテクチャ上の判断:**
- `web_search` / `web_fetch` ツールを丸ごと差し替える（既存コードへの侵食ゼロ）
- ブラウザ操作（ログイン・CAPTCHA・ページ遷移）は人間が行う
- URL開放とDOM取得は Chrome DevTools Protocol（CDP）で自動化し、人力ステップを排除
- `capturePageWithCdp` がURL開放（`openUrlAndGetTargetId`）・ユーザー待機・DOM取得を一貫して担う
- CDP `/json/new` のレスポンスからターゲットIDを取得し、`/json/list` で対応WS URLを特定することで、Chromeを他用途と共用していても正確なタブを選択できる（複数タブ誤選択問題の解消）
- CDP接続失敗時は自動でChrome起動を試みる（`browser-launcher.ts`）
- モードは起動時固定。実行中の動的切り替えは未サポート（v1）
- `auto` モードのツールは `human` モード時に完全無効化（誤送信防止）

## エージェント間通信フロー

### 作業依頼フロー（統一パス）

```
1. User → "調査してください" → Proxy Agent
2. Proxy LLM → start_research_loop ツール呼び出しを判断（タスク規模に応じたパラメータ設定）
3. start_research_loop.execute():
   a. Task Orchestratorがタスクを分析（必要に応じてWorkUnitに分解）
   b. Worker Agent.prompt(task) → LLM呼び出し + ツール実行
   c. Manager Agent が成果物を構造化評価
   d. qualityThreshold に基づき自律的に承認/改善
   e. 結果テキスト → ToolResult返却
4. Proxy Agent → ToolResultをユーザーに返却
```

### 改善依頼フロー（統一パス）

```
1. User → "設定を改善して" → Proxy Agent
2. Proxy LLM → start_research_loop ツール呼び出しを判断（qualityThreshold=70, maxIterations=5）
3. start_research_loop.execute():
   a. Worker Agent が改善タスクを実行
   b. Manager Agent が評価し、必要に応じて update_worker_config で設定変更
      - APPEND_SYSTEM.md バックアップ → 上書き → changelog追記
   c. 結果テキスト → ToolResult返却
4. Proxy Agent → 結果をユーザーに返却
```

### AgentRegistry

```typescript
class AgentRegistry {
  register(name, factory)  // ファクトリ関数を登録
  get(name) → Agent        // 遅延初期化 + キャッシュ + in-flight重複排除
  evict(name)              // インスタンス破棄（設定リロード用）
  shutdownAll()            // 全エージェントreset
}
```

- `get()` はファクトリ関数を初回のみ実行し、以降はキャッシュされたインスタンスを返す
- `evict()` はインスタンスを破棄する。次回の `get()` でファクトリが再実行され、最新の設定ファイルを読み込んだ新しいインスタンスが作成される
- 永続実行ループでは、Manager Agentが設定を更新した後に `evict("worker")` を呼び出し、次のイテレーションで Worker が最新設定を反映する

## 永続実行ループ（Persistence Loop）

### ループ構造

```
for iteration = 1 to maxIterations:
    1. Worker実行:    workProduct = executeWorker(task)
    2. 成果物評価:    evaluation = evaluateProduct(workProduct)
    3. ユーザー確認:  feedback = getUserFeedback(workProduct, evaluation, iteration)
       - approved  → ループ終了（成功）
       - interrupt → ループ終了（中断）
       - improve   → 続行
    4. 設定改善:      improvements = executeImprovement(requests)
    5. 繰り返し
```

### LoopCallbacks インターフェース

```typescript
interface LoopCallbacks {
  executeWorker(task: string): Promise<string>;
  evaluateProduct(workProduct: string): Promise<EvaluationReport>;
  getUserFeedback(workProduct: string, evaluation: EvaluationReport, iteration: number): Promise<UserFeedback>;
  executeImprovement(requests: ImprovementRequest[]): Promise<string[]>;
  onIterationComplete(result: IterationResult): void;
  readCurrentConfig(): Promise<string>;
}
```

### 統合レイヤー（loop-integration.ts）

`createLoopCallbacks()` がコールバックの具体実装を提供:

| コールバック | 実装 |
|---|---|
| `executeWorker` | `registry.get("worker")` → `agent.reset()` → `invokeAgent(worker, task)` |
| `evaluateProduct` | `registry.get("manager")` → 構造化評価プロンプト → `parseEvaluationReport()` |
| `getUserFeedback` | readline で評価結果表示 + `a/i/q` 選択 |
| `executeImprovement` | `formatImprovementRequest()` → `invokeAgent(manager, ...)` → `registry.evict("worker")` |
| `readCurrentConfig` | `loadAgentConfig(workerConfigDir)` |

### 安全機構

#### 停滞検出（Stagnation Detector）

直近 N イテレーション（デフォルト3）のスコア推移を監視。意味のある改善（デフォルト+2点以上）がない場合、停滞と判定してユーザーに通知。

#### 連続劣化ロールバック（Rollback Manager）

連続 N 回（デフォルト3）のスコア低下を検出した場合、ロールバックを推奨。最後の良好なイテレーション番号を提示。

#### レイテンシ監視（Latency Tracker）

各ステップ（Worker実行・評価・Manager改善）の所要時間を記録。平均値、ボトルネック特定（worker/evaluation/manager）、トレンド分析（increasing/decreasing/stable）、目標時間超過検知を提供。

#### タイムアウト

各イテレーションに `iterationTimeoutMs`（デフォルト600秒）を設定。超過時はそのイテレーションを `timeout` として記録しループ終了。

## 構造化評価レポート

### EvaluationReport

```typescript
interface EvaluationReport {
  qualityScore: number;         // 0-100
  issues: EvaluationIssue[];
  summary: string;
}

interface EvaluationIssue {
  category: "coverage" | "accuracy" | "structure" | "citations" | "other";
  description: string;
  evidence: string;
  cause: "config" | "task-difficulty" | "llm-limitation";
}
```

- `cause: "config"` の課題のみが `ImprovementRequest` に変換され、Manager Agentに送られる
- `cause: "task-difficulty"` や `"llm-limitation"` は設定変更では解決できないためスキップ

### ImprovementRequest（4点セット伝達フォーマット）

```typescript
interface ImprovementRequest {
  issueCategory: IssueCategory;      // 品質課題カテゴリ
  issueEvidence: string;              // 成果物の該当箇所
  workProductExcerpt: string;         // 成果物の関連部分
  relatedConfigSection: string;       // 現在の設定ファイルの関連部分
  improvementDirection: string;       // 期待される改善方向
  userFeedback: string;               // ユーザーフィードバック
}
```

## リスクと緩和策

| リスク | 緩和策 |
|---|---|
| LLM分類精度 | Proxy system promptに明確な分類基準 + ask_user フォールバック |
| Manager設定破壊 | APPEND_SYSTEM.mdのみ変更許可 + バックアップ + changelog |
| 改善逆効果 | 仮説→検証構造強制 + 連続劣化ロールバック |
| コンテキスト溢れ | PI toolkitの自動compaction活用 |
| ループ暴走 | max_iterations + ユーザー確認 + タイムアウト |
| 問題検知誤判定 | ユーザー確認ゲート（v1） + 構造化評価レポート |
| 時間爆発 | レイテンシ計測 + 目標上限 + 超過通知 |
| クローラーブロック・CAPTCHA | Human Mode（`SEARCH_MODE=human`）でブラウザ操作を人間に委譲し、CDP自動取得でDOM取得コストを最小化 |
