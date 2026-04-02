# pi-agent — Web調査エージェント

> **⚠ 本プロジェクトはアルファ版です。** API・設定仕様・内部構造は予告なく変更される可能性があります。本番環境での使用は推奨しません。

Web上の情報を自律的に収集・整理し、Markdownレポートや表形式データ（Excel）として出力するAIエージェント。品質に満足できるまで自動で改善を繰り返す。

## エージェントにできること

| 依頼の種類 | 例 |
|---|---|
| **包括的な調査レポート** | 「生成AIの市場動向をまとめてください」 |
| **製品・サービスの比較** | 「主要クラウドストレージサービスを比較してください」 |
| **技術調査** | 「Rustの非同期ランタイムの違いを調査してください」 |
| **単発の質問** | 「TypeScriptの最新バージョンは何ですか？」 |
| **設定の改善依頼** | 「出典をもっと増やすよう調査方法を改善してください」 |

### 成果物の形式

- **`output/report.md`** — 構造化されたMarkdownレポート（出典URL付き）
- **`output/*.xlsx`** — 列が多い比較表や一覧データはExcelファイルで出力
- **`output/subtask-*.md`** — サブトピックごとの中間調査ファイル

### 調査の特徴

- **出典明示**: すべての事実的主張に出典URLを付与
- **多角的な検索**: 同一テーマに複数クエリ・日英両方で検索
- **継続的な品質改善**: 満足できなければ「改善」を指示するだけで再調査
- **中断・再開**: 長時間調査は中断しても `output/progress.md` から再開可能

## アーキテクチャ

3つのコンポーネントが役割分担することで、長時間の調査も品質を保ちながら継続する。

```
User
 │
 ▼
Proxy ── リクエストを受け取り、調査ループを起動する
 │
 ▼
┌─────────────────────────────────────────┐
│  Persistence Loop                        │
│                                          │
│  Worker ──────────────────────────────→ │ 成果物生成
│    ↑                                     │
│    │ 設定改善                            │
│  Manager ←── ユーザーフィードバック      │ 評価・改善
└─────────────────────────────────────────┘
```

| コンポーネント | 役割 |
|---|---|
| **Proxy** | ユーザーリクエストの受付・分類・ループへのルーティング |
| **Manager** | ループ全体の記憶保持役・ユーザーとの対話窓口。成果物の評価、フィードバックの受信、Worker設定の改善をイテレーションをまたいで一貫して担う |
| **Worker** | 成果の生成に集中する実行専任エージェント。各イテレーションで独立して起動し、調査・レポート生成に専念する |

**Manager は会話履歴をループ全体で保持する。** ユーザーのフィードバックと過去の評価が蓄積され、後続イテレーションで一貫した改善判断が可能になる。Worker は毎回リセットされ最新設定のみを受け取るため、各回の実行に集中できる。

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

pi-agentはPI toolkitのプロバイダーシステムを使用する。サブスクリプション認証とAPIキー認証の両方に対応。

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
SEARXNG_TIMEOUT_MS=30000                 # デフォルト
SEARXNG_MAX_RESULTS=10                   # デフォルト
```

#### フォールバック検索プロバイダー（オプション）

SearXNGが利用できない場合に備え、外部検索APIをフォールバックとして設定できる。

```bash
SEARCH_FALLBACK_PROVIDERS=tavily,brave,serper  # 優先順位順にカンマ区切りで指定
TAVILY_API_KEY=tvly-...                        # Tavily API キー
BRAVE_API_KEY=...                              # Brave Search API キー
SERPER_API_KEY=...                             # Serper API キー
```

- `SEARCH_FALLBACK_PROVIDERS` が未設定の場合、SearXNG失敗時はエラーになる
- APIキーが未設定のプロバイダーはスキップされ、次のプロバイダーが試行される
- プロバイダーは記述順に試行され、最初に成功したものの結果を返す

### 人力取得モード（Human Mode）

クローラーブロック・CAPTCHA・ログイン必須コンテンツなど、自動取得が困難なサイトへの対策として **Human Mode** を用意している。ブラウザ操作は人間が行い、DOMの取得はCDPで自動化することで、人力を必要最小限に抑える。

```bash
SEARCH_MODE=human
```

**動作の流れ:**

1. Worker が `web_search` を呼び出すと、ターミナルに検索語が表示される
2. 人間がブラウザで検索し、結果ページを確認する（ログイン・CAPTCHA等も人間が処理）
3. 結果URLとスニペットをCLIに入力（空行で終了）
4. Worker が `web_fetch` を呼び出すと、対象URLがターミナルに表示される
5. 人間がページを開いた後 Enter を押すと、Chrome DevTools Protocol（CDP）でDOMを自動取得

**前提条件:**

- Google Chrome がインストールされていること（自動検索パスで解決。見つからない場合はパスを手動指定）
- Playwright がインストールされていること（`npm install` で自動インストール）

**注意:**

- `SEARCH_MODE=human` 時、SearXNG / フォールバックプロバイダーは使用されない
- モードは起動時に固定。実行中の切り替えは未サポート（v1）

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

### 調査を依頼する

自然な日本語でそのまま依頼できる:

```
生成AIの市場動向について包括的なレポートを作成してください
```

エージェントが自律的に調査を進め、品質基準を満たすまでループを継続する。各イテレーション後にスコアとサマリーが表示される。

```
TypeScriptの最新バージョンは何ですか？
```

単発の質問は1回の調査で即完了する。

```
レポートの出典をもっと増やすよう調査方法を改善してください
```

調査方法そのものへのフィードバックも受け付ける。Managerが設定を改善したうえで再調査する。

### 調査ループの操作

各イテレーション完了後、3つの選択肢が表示される:

| 選択 | 動作 |
|---|---|
| **approve** | 成果物を承認してループ終了 |
| **improve** | フィードバックを入力 → Managerが設定を改善して再調査 |
| **quit** | ループを中断 |

`improve` を選んでフィードバックを入力すると、そのフィードバックはManagerに直接届き、次のイテレーションの方針に反映される。

### プロジェクトのアーカイブとリセット

調査が一段落したら、成果物をアーカイブしてから新しいプロジェクトを開始する。

```bash
# 現在の成果物をスナップショット保存
npm run archive -- --name "生成AI市場調査"

# アーカイブ後、プロジェクトをリセットして次の調査へ
npm run new-project
```

アーカイブは `archives/{YYYY-MM-DD_HH-mm}_{name}/` に保存される:

```
archives/
  2026-03-25_19-30_生成AI市場調査/
    output/                  # 調査成果物（report.md, *.xlsx 等）
    logs/                    # Manager監査ログ
    agents/
      worker/
        APPEND_SYSTEM.md     # チューニング済みWorker設定
        changelog.md         # Managerによる変更履歴
    meta.json                # アーカイブ情報（タスク名・スコア・イテレーション数）
```

`archives/` は `.gitignore` 対象のため、調査成果物はバージョン管理から除外される。

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

## 設定ファイル

Workerの調査方針はMarkdownファイルで制御する。Managerが自律的に `APPEND_SYSTEM.md` を書き換えることで、調査品質を反復改善する。

```
agents/
  worker/
    agent.md           # ペルソナ・基本方針（人間が管理）
    system.md          # タスク実行ルール・制約（人間が管理）
    APPEND_SYSTEM.md   # Managerが動的に書き換える追加指示
    skills/            # スキル定義ファイル群
      excel-output.md  # Excel出力スキル
    backups/           # APPEND_SYSTEM.md のバックアップ
    changelog.md       # Managerによる変更履歴
  proxy/
    agent.md, system.md, APPEND_SYSTEM.md, skills/
  manager/
    agent.md, system.md, APPEND_SYSTEM.md, skills/
```

Managerが書き換えるのは `APPEND_SYSTEM.md` のみ。`agent.md` と `system.md` は人間が管理する。変更前にバックアップが自動作成され、`changelog.md` に変更記録が追記される。

## テスト

```bash
# ユニットテスト（212テスト）
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
- **Human Mode / CDP**: Playwright (`connectOverCDP`) + Chrome DevTools Protocol
- **Excel出力**: ExcelJS
- **Schema**: TypeBox
- **Test**: Node.js built-in test runner (`node:test`)

## 設計原則

1. **永続性**: エージェントは目的達成（ユーザー満足）まで作業を放棄しない
2. **汎用性**: 特定のタスクドメインやテストシナリオに結合したロジックを混入しない
3. **検証可能性**: すべての改善は仮説→変更→検証の構造で記録される
4. **安全性**: max_iterations、停滞検出、自動ロールバック、ユーザー確認による安全弁
5. **分業**: Managerが記憶・判断・対話を一貫して担い、Workerが実行に集中することで、それぞれの品質を最大化する
