# LLM設定ガイド

pi-agentを使うにはLLM（大規模言語モデル）への接続が必要です。このガイドでは、初めての方でも迷わないように、推奨される設定方法をステップバイステップで説明します。

> **前提**: Node.js 18+、npmがインストール済みで、`npm install` が完了していること。  
> 基本的なセットアップは [README.md](../README.md) を参照してください。

## 目次

- [方法の選び方](#方法の選び方)
- [推奨: .envファイルによる設定](#推奨-envファイルによる設定)
- [設定例1: Venice AI（シンプルなAPIキー）](#設定例1-venice-aiシンプルなapiキー)
- [設定例2: Azure OpenAI（企業向けクラウド）](#設定例2-azure-openai企業向けクラウド)
- [auth.jsonによる設定（上級者向け）](#authjsonによる設定上級者向け)
- [サブスクリプション認証（/login）](#サブスクリプション認証login)
- [モデルの選択](#モデルの選択)
- [エージェント別モデル設定](#エージェント別モデル設定)
- [トラブルシューティング](#トラブルシューティング)
- [対応プロバイダー一覧](#対応プロバイダー一覧)

---

## 方法の選び方

pi-agentには3つのLLM接続方法があります。迷ったら **方法1** から始めてください。

| 方法 | 難易度 | 向いている人 |
|------|--------|-------------|
| **方法1: .envファイル** | ★☆☆ 簡単 | 初めての方、個人利用 |
| **方法2: auth.json** | ★★☆ 中級 | 複数プロバイダーの切り替え、セキュリティ重視 |
| **方法3: /login（サブスクリプション）** | ★☆☆ 簡単 | Claude Pro/Max、ChatGPT Plus等の既存サブスクリプションがある方 |

---

## 推奨: .envファイルによる設定

**最もシンプルな方法です。** プロジェクトルートの `.env` ファイルにAPIキーを書くだけで動きます。

### 手順

```bash
# 1. テンプレートをコピー
cp .env.example .env

# 2. .env を編集して、使いたいプロバイダーのAPIキーを設定
#    （テキストエディタで開いてください）
```

`.env` ファイルの中身はこのような形式です:

```bash
# 使いたいプロバイダーの行のコメント(#)を外し、キーを入力
ANTHROPIC_API_KEY=sk-ant-xxxxxxxxxxxxx
```

> **セキュリティ注意**: `.env` ファイルには秘密情報が含まれます。**Gitにコミットしないでください**。`.gitignore` に `.env` が含まれていることを確認してください。

### 動作確認

```bash
npm start
# 起動後、/model でモデル一覧が表示されればOK
```

---

## 設定例1: Venice AI（シンプルなAPIキー）

Venice AIは多数のオープンソースモデル（Llama、Qwen、DeepSeek等）を単一のAPIキーで利用できるサービスです。手軽に始められるため、最初のプロバイダーとしておすすめです。

### ステップ1: APIキーの取得

1. [Venice AI](https://venice.ai/) にアクセスし、アカウントを作成
2. ログイン後、[APIキー管理ページ](https://venice.ai/settings/api) を開く
3. 「Generate API Key」をクリック
4. 生成されたキーをコピー（`vnc-` で始まる文字列）

> **注意**: APIキーは生成時に一度だけ表示されます。必ずこの時点でコピーしてください。

### ステップ2: .envファイルに設定

```bash
# .env
VENICE_API_KEY=vnc-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### ステップ3: 起動して確認

```bash
npm start
```

起動したら `/model` と入力してモデル一覧を確認します。Veniceのモデルが表示されれば成功です。

### Venice AIで使えるおすすめモデル

| モデル名 | 特徴 |
|---------|------|
| `qwen/qwen3-235b` | 高性能な汎用モデル。コーディングにも強い |
| `deepseek/deepseek-r1-0528` | 推論特化。複雑なタスクに向く |
| `google/gemma-3-27b-it` | Googleの軽量高品質モデル |
| `meta-llama/llama-4-maverick` | Metaの最新モデル |

---

## 設定例2: Azure OpenAI（企業向けクラウド）

Azure OpenAIは、企業のセキュリティ要件（データ所在地、プライベートネットワーク等）を満たすMicrosoftのクラウドサービスです。社内利用や業務利用に適しています。

> **前提**: Azureサブスクリプションと、Azure OpenAI Serviceへのアクセス権が必要です。社内のIT管理者に確認してください。

### ステップ1: Azure側の準備

Azure OpenAIを使うには、Azure Portal上で以下が必要です（IT管理者が設定済みの場合あり）:

1. **Azure OpenAI リソース** が作成されていること
2. **モデルがデプロイ** されていること（例: `gpt-4o` を `my-gpt4o` という名前でデプロイ）
3. **APIキー** が発行されていること

確認方法:
- [Azure Portal](https://portal.azure.com/) → 「Azure OpenAI」で検索
- リソースを選択 → 「キーとエンドポイント」でAPIキーとエンドポイントURLを確認
- 「モデルデプロイ」でデプロイ済みモデル名を確認

### ステップ2: .envファイルに設定

Azure OpenAIは通常のAPIキーに加えて、いくつかの追加設定が必要です:

```bash
# .env

# 必須: APIキー
AZURE_OPENAI_API_KEY=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# 必須（どちらか一方）: エンドポイント
AZURE_OPENAI_BASE_URL=https://your-resource-name.openai.azure.com
# または
AZURE_OPENAI_RESOURCE_NAME=your-resource-name

# 任意: APIバージョン（通常はデフォルトで問題なし）
# AZURE_OPENAI_API_VERSION=2024-02-01

# 任意: デプロイ名のマッピング
# Azureではモデルに独自のデプロイ名を付けるため、対応を指定する
# 形式: 標準モデル名=デプロイ名  をカンマ区切りで指定
AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-4o=my-gpt4o,gpt-4=my-gpt4
```

> **IT管理者から受け取る情報**: APIキー、エンドポイントURL（またはリソース名）、デプロイ名。この3つがあれば設定できます。

### ステップ3: 起動して確認

```bash
npm start
```

起動後、`/model` で Azure OpenAI のモデルが選択できれば成功です。

### Azure OpenAI 設定のポイント

| 項目 | 説明 | 例 |
|------|------|-----|
| `AZURE_OPENAI_API_KEY` | Azure Portalで取得するAPIキー | `abc123...` |
| `AZURE_OPENAI_BASE_URL` | リソースのエンドポイントURL | `https://mycompany.openai.azure.com` |
| `AZURE_OPENAI_RESOURCE_NAME` | BASE_URLの代わりにリソース名だけでもOK | `mycompany` |
| `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` | モデル名とデプロイ名の対応 | `gpt-4o=my-gpt4o` |

---

## auth.jsonによる設定（上級者向け）

`~/.pi/agent/auth.json` にAPIキーを保存する方法です。環境変数より優先されます。

### 基本形式

```json
{
  "anthropic": { "type": "api_key", "key": "sk-ant-..." },
  "venice": { "type": "api_key", "key": "vnc-..." },
  "azure-openai-responses": { "type": "api_key", "key": "..." }
}
```

### 高度な使い方: シェルコマンドでの動的取得

APIキーを直接ファイルに書きたくない場合、シェルコマンドで動的に取得できます:

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!op read 'op://vault/Anthropic/api-key'"
  }
}
```

`!` で始まる値はシェルコマンドとして実行され、標準出力がAPIキーとして使われます。1Passwordやmacのキーチェーンなど、パスワードマネージャーとの連携に便利です。

### キーの3つの記法

| 記法 | 例 | 用途 |
|------|-----|------|
| シェルコマンド | `"!op read '...'"` | パスワードマネージャー連携 |
| 環境変数名 | `"MY_CUSTOM_KEY"` | 環境変数からの読み取り |
| リテラル値 | `"sk-ant-..."` | 直接指定 |

---

## サブスクリプション認証（/login）

Claude Pro/MaxやChatGPT Plus等のサブスクリプションをお持ちの方は、APIキーなしで利用できます。

```bash
npm start
# セッション内で:
#   /login → プロバイダーを選択 → ブラウザが開いて認証
#   /model → モデルを選択
```

対応サービス:
- Claude Pro/Max
- ChatGPT Plus/Pro (Codex)
- GitHub Copilot
- Google Gemini CLI
- Google Antigravity

認証情報は `~/.pi/agent/auth.json` に自動保存され、有効期限が切れると自動更新されます。

---

## モデルの選択

LLMの設定が完了したら、使用するモデルを選びます。

### 対話的に選ぶ

```bash
npm start
# /model と入力 → 利用可能なモデル一覧が表示される → 選択
```

### コマンドラインで指定する

```bash
# プロバイダーとモデルを直接指定して起動
npm start -- --provider venice --model qwen/qwen3-235b
npm start -- --provider azure-openai-responses --model gpt-4o
```

### モデル選びのポイント

- **コーディング作業**: `claude-sonnet-4-20250514`（Anthropic）、`gpt-4o`（OpenAI/Azure）、`qwen/qwen3-235b`（Venice）が高性能
- **コスト重視**: Venice AI のオープンソースモデルは比較的安価
- **企業利用**: Azure OpenAI でデータの所在地やコンプライアンスを確保
- **お試し**: `/login` でサブスクリプション認証を使えば追加コスト不要

---

## エージェント別モデル設定

pi-agentは内部に3つのエージェント（Worker、Manager、Proxy）を持っています。デフォルトでは全エージェントが同じモデルを使いますが、`.env` でエージェントごとに異なるモデルを指定できます。

### なぜエージェント別に設定するのか？

| エージェント | 役割 | 推奨モデル特性 |
|-------------|------|---------------|
| **Worker** | コード生成・ファイル操作・調査 | コーディング能力が高いモデル |
| **Manager** | Worker成果物の評価・指示出し | 判断力・推論力が高いモデル |
| **Proxy** | ユーザーとの対話・タスク振り分け | バランスの良いモデル |

例えば、Workerには高速で安価なモデルを使い、Managerには高品質な推論モデルを使うといったコスト最適化が可能です。

### 設定方法

`.env` ファイルに `プロバイダー名/モデルID` の形式で指定します:

```bash
# .env

# エージェント別モデル設定（任意）
# 形式: プロバイダー名/モデルID
WORKER_MODEL=venice/qwen3-235b
MANAGER_MODEL=anthropic/claude-sonnet-4-20250514
# PROXY_MODEL=openai/gpt-4o   ※現在未対応（今後対応予定）
```

### 設定ルール

1. **未設定の場合** — メインセッションのモデル（`/model` や `--model` で選択したもの）が使われます
2. **形式** — `プロバイダー名/モデルID`（例: `venice/qwen3-235b`）。スラッシュが必須です
3. **APIキー** — 使用するプロバイダーのAPIキーが `.env` または `auth.json` で設定されている必要があります
4. **PROXY_MODEL** — 現時点ではWorkerとManagerのみ対応しています。Proxyのモデルは `/model` コマンドまたは `--model` オプションで指定してください

### 設定例: コスト最適化

```bash
# .env
VENICE_API_KEY=vnc-xxxxx
ANTHROPIC_API_KEY=sk-ant-xxxxx

# Workerは安価なVeniceモデルで高速に作業
WORKER_MODEL=venice/qwen3-235b

# Managerは高品質なClaudeで正確に評価
MANAGER_MODEL=anthropic/claude-sonnet-4-20250514
```

### 設定例: 全エージェント同じプロバイダー

```bash
# .env
OPENAI_API_KEY=sk-xxxxx

# 全エージェントにOpenAIを使用
WORKER_MODEL=openai/gpt-4o
MANAGER_MODEL=openai/gpt-4o
```

> **ヒント**: `npm start` で起動後、各エージェントがどのモデルを使っているかはログで確認できます。モデルが見つからない場合はエラーメッセージに原因が表示されます。

---

## トラブルシューティング

### 「モデルが見つからない」

```
Error: No models available for provider ...
```

**原因**: APIキーが正しく設定されていないか、プロバイダー名が間違っている。

**対処**:
1. `.env` ファイルの環境変数名が正しいか確認（大文字・アンダースコアに注意）
2. APIキーの値にスペースや改行が含まれていないか確認
3. `npm start` を再起動（`.env` の変更は再起動で反映される）

### Azure OpenAIで「デプロイが見つからない」

```
Error: The API deployment for this resource does not exist
```

**対処**:
- `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` でモデル名とデプロイ名の対応を正しく設定する
- Azure Portal でモデルがデプロイ済みか確認する

### APIキーが無効

```
Error: 401 Unauthorized
```

**対処**:
- APIキーの有効期限が切れていないか確認
- キーをコピーし直す（前後の空白に注意）
- プロバイダーの管理画面でキーが有効か確認

### `/login` でブラウザが開かない

**対処**:
- ターミナルに表示されるURLを手動でブラウザに貼り付ける
- ファイアウォールやプロキシが通信をブロックしていないか確認

### エージェント別モデル設定のエラー

```
Error: Invalid WORKER_MODEL format: "invalid". Expected "provider/model-id"
```

**対処**: `WORKER_MODEL`（または `MANAGER_MODEL`）の値が `プロバイダー名/モデルID` の形式になっているか確認してください。スラッシュ (`/`) で区切る必要があります。

```
Error: Model not found for WORKER_MODEL="venice/nonexistent"
```

**対処**:
- モデルIDが正しいか確認（`/model` で利用可能なモデル一覧を確認）
- 対応するプロバイダーのAPIキーが設定されているか確認

---

## 対応プロバイダー一覧

| プロバイダー | 環境変数 | auth.jsonキー | 特徴 |
|-------------|---------|--------------|------|
| Anthropic | `ANTHROPIC_API_KEY` | `anthropic` | Claude系モデル |
| OpenAI | `OPENAI_API_KEY` | `openai` | GPT系モデル |
| Azure OpenAI | `AZURE_OPENAI_API_KEY` | `azure-openai-responses` | 企業向けOpenAI |
| Google Gemini | `GEMINI_API_KEY` | `google` | Gemini系モデル |
| Venice AI | `VENICE_API_KEY` | `venice` | オープンソースモデル多数 |
| Mistral | `MISTRAL_API_KEY` | `mistral` | Mistral/Codestral |
| Groq | `GROQ_API_KEY` | `groq` | 高速推論 |
| xAI | `XAI_API_KEY` | `xai` | Grok系モデル |
| OpenRouter | `OPENROUTER_API_KEY` | `openrouter` | 複数プロバイダーの統合ゲートウェイ |

全プロバイダーの詳細: [PI toolkit providers.md](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/providers.md)
