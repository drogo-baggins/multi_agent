# pi-agent

PI TypeScript toolkit上に構築されたマルチエージェントフレームワーク。Worker Agentの振る舞いを制御するMarkdown設定ファイルを、Manager Agentが自律的にチューニングすることで、ユーザーが満足するまで成果物の品質を継続的に改善する。

## 概要

```
User → InteractiveMode Session → [調査タスク]   → start_research_loop → Worker ⇄ Manager ループ
                                → [単発作業]     → route_to_worker → Worker Agent → 成果物
                                → [改善依頼]     → route_to_manager → Manager Agent → Worker設定更新
                                → [曖昧なリクエスト] → ask_user → ユーザーに確認
```

### エージェント構成

PI toolkitの `InteractiveMode` がメインセッションを管理し、カスタムツール経由でサブエージェントにルーティングする。

| コンポーネント | 役割 | ツール |
|---|---|---|
| **メインセッション** | ユーザーリクエストの分類・ルーティング（PI toolkit InteractiveMode） | `start_research_loop`, `route_to_worker`, `route_to_manager`, `ask_user`, `web_search`, `web_fetch` + PI標準ツール |
| **Worker Agent** | サンドボックス内でWeb調査・レポート生成 | `web_search`, `web_fetch`, `bash`, `read_file`, `write_file` 等 |
| **Manager Agent** | Worker設定の分析・改善・効果検証 | `read_worker_config`, `read_work_product`, `update_worker_config`, `evaluate_work_product`, `read_changelog` |

### 核心機能: 永続実行ループ（Persistence Loop）

`start_research_loop` ツールが起動する自律的な品質改善サイクル。ユーザーの明示的な承認まで作業を放棄しない。

```
Worker実行 → Manager評価 → ユーザー確認 → [承認] → 完了
                                        → [改善] → Manager設定改善 → Worker再実行 → ...
                                        → [中断] → ループ終了
```

安全機構: max_iterations上限、停滞検出、連続劣化ロールバック、レイテンシ監視。

## セットアップ

### 前提条件

- Node.js 18+
- npm
- Docker（Web検索機能を使う場合 — SearXNG用）

### インストール

```bash
npm install
```

### LLMプロバイダー設定

pi-agentはPI toolkitのプロバイダーシステムをそのまま使用する。サブスクリプション認証とAPIキー認証の両方に対応。

#### サブスクリプション認証（/login）

起動後、`/login` コマンドでOAuth認証を行う:

- Claude Pro/Max
- ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

```bash
npm start
# セッション内で:
# /login → プロバイダーを選択 → ブラウザで認証
# /model → モデルを選択
```

認証情報は `~/.pi/agent/auth.json` に保存され、自動更新される。

#### APIキー認証（環境変数）

```bash
# 例: Anthropic
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

対応プロバイダー（抜粋）:

| プロバイダー | 環境変数 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

全プロバイダー一覧: [PI toolkit providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)

#### auth.json による設定

`~/.pi/agent/auth.json` にAPIキーを保存することも可能:

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." }
}
```

シェルコマンドでの動的取得にも対応（例: `"key": "!op read 'op://vault/item/credential'"`）。

### Web検索（SearXNG）

Web検索・Web取得機能にはSearXNGインスタンスが必要。

#### SearXNGの起動

```bash
# Windows
.\scripts\searxng-start.ps1

# Linux/macOS
./scripts/searxng-start.sh
```

または手動で:

```bash
docker run -d -p 8888:8080 --name searxng searxng/searxng
```

#### SearXNG環境変数（オプション）

```bash
SEARXNG_URL=http://localhost:8888        # デフォルト
SEARXNG_TIMEOUT_MS=30000                 # デフォルト（ミリ秒）
SEARXNG_MAX_RESULTS=10                   # デフォルト
SEARXNG_MAX_RETRIES=3                    # デフォルト: 429/502/503/504 時のリトライ回数
SEARXNG_CONCURRENCY_LIMIT=2             # デフォルト: 同時リクエスト数の上限
```

### 環境変数の設定（.envファイル）

プロジェクトルートに `.env` ファイルを配置すると、起動時に自動で環境変数が読み込まれる。

```bash
cp .env.example .env
# .env を編集して必要な値を設定
```

既に設定済みの環境変数は `.env` によって上書きされない（実環境が常に優先）。

## 使い方

### 起動

```bash
npm start
```

PI toolkitのインタラクティブセッションが起動する。初回起動時は `/login` でプロバイダー認証、`/model` でモデル選択を行う。

### 調査タスクの例

```
AIの歴史について包括的なレポートを作成してください
```
→ メインセッションが `start_research_loop` を使用 → Worker実行 → Manager評価 → ユーザー確認のループ

```
TypeScriptの最新バージョンって何？
```
→ 単発の質問として `route_to_worker` → Worker が回答

```
レポートの出典をもっと増やすよう設定を改善してください
```
→ `route_to_manager` → Manager が Worker設定を更新

### PI toolkit標準コマンド

| コマンド | 説明 |
|---|---|
| `/login` | プロバイダー認証 |
| `/logout` | 認証情報クリア |
| `/model` | モデル選択 |
| `ctrl+p` | モデル切り替え |
| `ctrl+c` | 入力クリア |
| `ctrl+c` ×2 | 終了 |
| `/` | コマンド一覧 |

### 永続実行ループの動作

`start_research_loop` が起動すると、各イテレーションで:

1. **Worker Agent** がタスクを実行し成果物を生成
2. **Manager Agent** が成果物を構造化評価（品質スコア + 課題分類）
3. **ユーザーに判断を求める**:
   - **approve**: 成果物を承認しループ終了
   - **improve**: 改善フィードバックを入力 → Manager が Worker設定を改善
   - **quit**: ループ中断

ループ終了後、停滞検出・ロールバック推奨・レイテンシ警告が必要に応じて適用される。

## 設定ファイル

各エージェントの振る舞いはMarkdownファイルで制御する。

```
agents/
  worker/
    agent.md           # ペルソナ・基本方針
    system.md          # タスク実行ルール・制約
    APPEND_SYSTEM.md   # Manager Agentが動的に書き換える追加指示
    skills/            # スキル定義ファイル群
    backups/           # APPEND_SYSTEM.md のバックアップ
    changelog.md       # Manager Agentによる変更履歴
  proxy/
    agent.md, system.md, APPEND_SYSTEM.md, skills/
  manager/
    agent.md, system.md, APPEND_SYSTEM.md, skills/
```

### 設定ファイルの組み立て順序

systemPromptは以下の順序で結合される:
1. `agent.md`
2. `system.md`
3. `skills/*.md`（アルファベット順）
4. `APPEND_SYSTEM.md`

### Manager Agentの改善範囲

Manager Agentが書き換えるのは `APPEND_SYSTEM.md` のみ。`agent.md` と `system.md` は人間が管理する。変更前にバックアップが自動作成され、`changelog.md` に構造化された変更記録が追記される。

## テスト

```bash
# ユニットテスト（110テスト）
npm test

# 型チェック
npm run typecheck

# E2E + POCテスト（APIキー必要、未設定時はスキップ）
ANTHROPIC_API_KEY=sk-ant-... npm test
```

## ビルド

```bash
npm run build
```

`dist/` に JavaScript + 型定義 + ソースマップが出力される。

## ドキュメント

- [LLM設定ガイド](docs/llm-setup-guide.md) — LLMプロバイダーの設定方法（Azure OpenAI、Venice AI等の設定例付き）
- [Architecture Guide](docs/architecture.md) — 設計判断とシステム構成
- [API Reference](docs/api-reference.md) — モジュール別の公開API
- [Developer Guide](docs/developer-guide.md) — 開発環境・テスト・ディレクトリ構造

## 技術スタック

- **Runtime**: Node.js (ES2022, ESM)
- **Language**: TypeScript (strict mode)
- **LLM Framework**: PI TypeScript toolkit (`pi-ai`, `pi-agent-core`, `pi-coding-agent`)
- **LLMプロバイダー**: PI toolkitがサポートする全プロバイダー（Anthropic, OpenAI, Azure, Google, GitHub Copilot, Mistral, Groq 等）
- **Web検索**: SearXNG（Docker）
- **Schema**: TypeBox
- **Test**: Node.js built-in test runner (`node:test`)

## 設計原則

1. **永続性**: エージェントは目的達成（ユーザー満足）まで作業を放棄しない
2. **汎用性**: 特定のタスクドメインやテストシナリオに結合したロジックを混入しない
3. **検証可能性**: すべての改善は仮説→変更→検証の構造で記録される
4. **安全性**: max_iterations、停滞検出、自動ロールバック、ユーザー確認による安全弁
