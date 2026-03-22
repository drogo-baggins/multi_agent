# Developer Guide

## 開発環境セットアップ

### 前提条件

- Node.js 18+
- npm 9+
- TypeScript 5.9+

### インストール

```bash
cd pi-agent
npm install
```

### 環境変数

```bash
# LLM APIキー（E2E・POCテスト実行に必要）
export ANTHROPIC_API_KEY=sk-ant-...
```

## プロジェクト構造

```
pi-agent/
├── agents/                    # エージェント設定ファイル（Markdown）
│   ├── worker/
│   │   ├── agent.md           # Worker ペルソナ
│   │   ├── system.md          # Worker ルール
│   │   ├── APPEND_SYSTEM.md   # Manager が動的に書き換え
│   │   ├── skills/            # スキル定義
│   │   ├── backups/           # APPEND_SYSTEM.md バックアップ
│   │   └── changelog.md       # 変更履歴
│   ├── proxy/
│   │   ├── agent.md
│   │   ├── system.md
│   │   ├── APPEND_SYSTEM.md
│   │   └── skills/
│   └── manager/
│       ├── agent.md
│       ├── system.md
│       ├── APPEND_SYSTEM.md
│       └── skills/
├── src/                       # TypeScript ソースコード
│   ├── index.ts               # CLI REPL エントリーポイント
│   ├── config/                # 設定ファイルローダー
│   │   ├── config-loader.ts
│   │   ├── config-initializer.ts
│   │   ├── config-loader.test.ts
│   │   └── index.ts
│   ├── communication/         # エージェント間通信基盤
│   │   ├── agent-registry.ts
│   │   ├── invoke-agent.ts
│   │   ├── event-relay.ts
│   │   ├── agent-registry.test.ts
│   │   └── index.ts
│   ├── agents/                # エージェントファクトリ
│   │   ├── worker-agent.ts
│   │   ├── manager-agent.ts
│   │   ├── proxy-agent.ts
│   │   ├── worker-agent.test.ts
│   │   ├── manager-agent.test.ts
│   │   ├── proxy-agent.test.ts
│   │   └── index.ts
│   ├── tools/                 # エージェントツール定義
│   │   ├── web-search-tool.ts
│   │   ├── sandboxed-tools.ts
│   │   ├── manager-tools.ts
│   │   ├── proxy-tools.ts
│   │   ├── manager-tools.test.ts
│   │   └── index.ts
│   ├── loop/                  # 永続実行ループ
│   │   ├── persistence-loop.ts
│   │   ├── evaluation-report.ts
│   │   ├── improvement-request.ts
│   │   ├── stagnation-detector.ts
│   │   ├── latency-tracker.ts
│   │   ├── rollback-manager.ts
│   │   ├── loop-integration.ts
│   │   ├── persistence-loop.test.ts
│   │   ├── stagnation-detector.test.ts
│   │   ├── latency-tracker.test.ts
│   │   ├── rollback-manager.test.ts
│   │   ├── loop-integration.test.ts
│   │   └── index.ts
│   └── integration/           # 統合テスト（LLM API必要）
│       ├── e2e.test.ts
│       └── poc-validation.test.ts
├── workspace/                 # Worker Agent のサンドボックス（実行時生成）
├── dist/                      # ビルド出力
├── package.json
├── tsconfig.json
└── docs/
    ├── architecture.md
    ├── api-reference.md
    └── developer-guide.md
```

## コマンド一覧

| コマンド | 説明 |
|---|---|
| `npm start` | CLI REPL を起動 |
| `npm test` | ユニットテスト実行（56テスト） |
| `npm run typecheck` | TypeScript 型チェック |
| `npm run build` | JavaScript + 型定義をビルド (`dist/`) |

## テスト

### テスト構成

| カテゴリ | ファイル数 | テスト数 | LLM不要 |
|---|---|---|---|
| ユニットテスト | 10ファイル | 56 | Yes |
| E2E統合テスト | 1ファイル | 4 | No |
| POC検証テスト | 1ファイル | 3 | No |

### ユニットテスト

```bash
npm test
# または
npx tsx --test src/**/*.test.ts
```

LLM API不要。すべてモックベースで動作する。

**テスト内訳**:
- `config-loader.test.ts` — 設定ファイル読み込み（5テスト）
- `agent-registry.test.ts` — レジストリのライフサイクル（5テスト）
- `invoke-agent.test.ts` / `event-relay.test.ts` — 通信ヘルパー（4テスト）
- `worker-agent.test.ts` — Worker生成（3テスト）
- `manager-agent.test.ts` — Manager生成（2テスト）
- `proxy-agent.test.ts` — Proxy生成・ルーティング（4テスト）
- `manager-tools.test.ts` — Manager ツール（5テスト）
- `persistence-loop.test.ts` — ループロジック（8テスト）
- `stagnation-detector.test.ts` — 停滞検出（4テスト）
- `latency-tracker.test.ts` — レイテンシ監視（4テスト）
- `rollback-manager.test.ts` — ロールバック判定（4テスト）
- `loop-integration.test.ts` — ループ統合層（8テスト）

### E2E統合テスト

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx --test src/integration/e2e.test.ts
```

`ANTHROPIC_API_KEY` 未設定時は自動スキップ。各テスト120秒タイムアウト。

- 8.1: 作業依頼フロー（Proxy → Worker）
- 8.2: 改善依頼フロー（Proxy → Manager → 設定更新）
- 8.3: 曖昧リクエスト（ask_user フロー）
- 8.4: 設定反映確認（Manager更新 → Worker再作成 → 新設定反映）

### POC検証テスト

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx --test src/integration/poc-validation.test.ts
```

`ANTHROPIC_API_KEY` 未設定時は自動スキップ。各テスト180秒タイムアウト。

- 11.1: 問題検知精度（低品質設定 → 評価が課題を検出するか）
- 11.2: MD調整実効性（Manager改善 → Worker出力が変化するか）
- 11.3: 改善ループ収束性（永続実行ループが正常に動作するか）

## コーディング規約

### TypeScript設定

- Target: ES2022
- Module: ES2022 (ESM)
- Strict mode: 有効
- Import paths: `.js` 拡張子必須

### パターン

**Named exports のみ**（default export 禁止）

```typescript
// Good
export function createWorkerAgent(...) { ... }

// Bad
export default function createWorkerAgent(...) { ... }
```

**AgentTool 定義パターン**

```typescript
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import type { Static } from "@sinclair/typebox";

const MyParametersSchema = Type.Object({
  message: Type.String()
});

type MyParameters = Static<typeof MyParametersSchema>;

export function createMyTool(): AgentTool<typeof MyParametersSchema> {
  return {
    name: "my_tool",
    label: "My Tool",
    description: "Does something useful.",
    parameters: MyParametersSchema,
    async execute(_toolCallId: string, params: MyParameters) {
      return {
        content: [{ type: "text", text: "result" }],
        details: undefined
      };
    }
  };
}
```

**テストパターン**

```typescript
import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";

describe("my feature", () => {
  it("does something", async () => {
    // Arrange
    const mockAgent = {
      prompt: mock.fn(async () => {}),
      waitForIdle: mock.fn(async () => {}),
      state: { messages: [], systemPrompt: "", tools: [] },
      subscribe: mock.fn(() => () => {}),
      reset: mock.fn(() => {}),
      setTools: mock.fn(() => {})
    } as unknown as Agent;

    // Act
    const result = await someFunction(mockAgent);

    // Assert
    assert.equal(result, expected);
  });
});
```

### 禁止事項

- `as any`, `@ts-ignore`, `@ts-expect-error` の使用禁止
- 空の catch ブロック `catch(e) {}` 禁止
- テスト内での特定タスクドメインへの依存禁止（汎用性保証原則）
- テスト通過のためだけの条件分岐禁止

## モジュール依存関係

```
index.ts
  ├── agents/ (worker-agent, manager-agent, proxy-agent)
  │     ├── config/ (config-loader)
  │     ├── tools/ (web-search-tool, sandboxed-tools, manager-tools, proxy-tools)
  │     └── communication/ (agent-registry, invoke-agent, event-relay)
  └── loop/ (persistence-loop, loop-integration, evaluation-report,
             improvement-request, stagnation-detector, latency-tracker, rollback-manager)
            ├── config/ (config-loader)
            └── communication/ (agent-registry, invoke-agent)
```

**重要な設計制約**: `src/loop/` 内のコアファイル（`persistence-loop.ts`, `evaluation-report.ts`, `improvement-request.ts`, `stagnation-detector.ts`, `latency-tracker.ts`, `rollback-manager.ts`）はPI toolkitに一切依存しない。唯一の接点は `loop-integration.ts` のみ。

## 新しいエージェント/ツールの追加

### 新しいツールを追加する場合

1. `src/tools/` に新ファイルを作成
2. TypeBoxでパラメータスキーマを定義
3. `AgentTool` 型のファクトリ関数をexport
4. `src/tools/index.ts` にre-exportを追加
5. 対応するエージェントファクトリの `setTools()` に追加
6. テストを作成

### 新しいエージェントを追加する場合

1. `agents/<name>/` に設定ファイルを作成（agent.md, system.md, APPEND_SYSTEM.md, skills/）
2. `src/agents/<name>-agent.ts` にファクトリ関数を作成
3. `src/agents/index.ts` にre-exportを追加
4. `src/index.ts` の `AgentRegistry` にファクトリを登録
5. 必要に応じて Proxy のルーティングツールを追加
6. テストを作成
