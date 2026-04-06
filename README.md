# エージェントといっしょにディープリサーチ！

> **⚠ 本プロジェクトはアルファ版です。** API・設定仕様・内部構造は予告なく変更される可能性があります。本番環境での使用は推奨しません。

このプロジェクトは、逆human-in-the-loopを採用。高度な管理作業、判断をエージェントが行い、人間は単純作業を担当します。早速managerエージェントに調べたいことを頼んでみましょう。

| 担当 | 役割 |
|---|---|
| **Manager エージェント** | 調査・分析の全体構成と成果物の品質に責任を負います |
| **Worker エージェント** | 調査対象の専門家として、様々な深掘り調査を行います |
| **あなた** | ブラウザ上のボタンを押すだけの簡単なお仕事です 🎉 |

## まず読むもの

1. [Human Mode ガイド](docs/human-mode.md) - **初めての方はここから**。Chrome のセットアップから実際の操作まで、ステップバイステップで説明しています。
2. [Architecture Guide](docs/architecture.md) - 仕組みを知りたい方向け。
3. [API Reference](docs/api-reference.md) - 開発者向けの詳細です。

## 何がうれしいのか

- 社内ネットワーク環境で外部検索APIが使えない場合でも動作します。
- 調査内容の品質に責任を持てます。エージェントが自動で品質チェックを繰り返します。
- クローラー対策、CAPTCHA、ログイン壁を手動で突破できます。
- 前提条件は **Node.js** と **Chrome** だけです。Docker も SearXNG もなくても始められます。

## エージェントにできること

| 依頼の種類 | 例 |
|---|---|
| **包括的な調査レポート** | 「生成AIの市場動向をまとめてください」 |
| **製品・サービスの比較** | 「主要クラウドストレージサービスを比較してください」 |
| **技術調査** | 「Rustの非同期ランタイムの違いを調査してください」 |
| **単発の質問** | 「TypeScriptの最新バージョンは何ですか？」 |
| **設定の改善依頼** | 「出典をもっと増やすよう調査方法を改善してください」 |

## 成果物の形式

| ファイル | 内容 |
|---|---|
| `workspace/output/report.md` | 構造化された Markdown レポート |
| `workspace/output/*.xlsx` | 比較表・一覧データ |
| `workspace/output/subtask-*.md` | サブトピックごとの中間調査ファイル |
| `workspace/task-plan.md` | タスク構造（L1〜L3）と WorkUnit 進捗（TODO/DOING/DONE） |

サンプル成果物として [docs/sample.pdf](docs/sample.pdf) を用意しました。中身は、最終成果物がどんな見た目と構成になるかを確認するための見本です。

## `workspace/task-plan.md` の見え方

`workspace/task-plan.md` には、調査の構造と進捗が LOGSEQ スタイルで記録されます。

```markdown
# タスク計画

**タスク**: 生成AI市場調査
**作成日時**: 2026-04-05T12:00:00.000Z
**ステータス**: running

## 成果物構造
- TODO [L1-001] 市場動向の全体像
  - スコープ: 主要プレイヤー、成長率、用途
  - DOING [L2-001] 主要プレイヤーの整理
    - スコープ: 企業・製品・提供形態
    - DONE [L3-001] 公式情報の収集
      - 品質スコア: 90/100
      - findingsFile: output/wu-L3-001-findings.md
      - 開始時刻: 2026-04-05T12:10:00.000Z
      - 完了時刻: 2026-04-05T12:18:00.000Z

## ユーザー指示履歴
- なし

## 合成完了
- 完了時刻: 2026-04-05T13:00:00.000Z
- WorkUnit数: 1
```

## 使い方

### Step 1: 前提条件の確認

まずは次を確認してください。

```bash
node --version
```

`v18` 以上が表示されれば OK です。あわせて Google Chrome がインストールされていることも確認してください。

### Step 2: インストール

リポジトリをダウンロードしたら、プロジェクトルートで依存関係を入れます。

```bash
npm install
```

### Step 3: LLM の設定

まずは `/login` による OAuth 認証がおすすめです。

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

APIキーでの設定は上級者向けです。後半の「自動化したい場合」を見てください。

### Step 4: Chrome のセットアップ確認

Human Mode では Chrome を使います。まずは起動確認をしましょう。

```bash
npm run chrome-setup
```

成功すると、Chrome の検出と CDP 接続が OK と表示されます。

### Step 5: 起動と調査依頼

```bash
npm start
```

あとは自然な日本語で調査を依頼できます。

```text
生成AIの市場動向について包括的なレポートを作成してください
```

```text
主要クラウドストレージサービスを比較してください
```

```text
Rustの非同期ランタイムの違いを調査してください
```

```text
TypeScriptの最新バージョンは何ですか？
```

### Step 6: ブラウザのボタンを押す

調査中はブラウザ上部に確認オーバーレイが表示されます。ページを自由に操作して、ログインや CAPTCHA 解除を済ませてからボタンを押せます。TUI（ターミナル）への入力は不要です。

- **✅ キャプチャして続行**: そのページを取得して次へ進みます。
- **⏭ スキップ**: その URL を取得せずに次へ進みます。

### Step 7: 成果物の確認

調査が終わったら、まず `workspace/output/report.md` を確認してください。調査の構造と進捗は `workspace/task-plan.md` で見られます。

別ターミナルで確認するなら、次のようにします。

```bash
cat workspace/task-plan.md
```

## 調査ループの操作

各イテレーション完了後、次の選択肢が表示されます。

| 操作 | 動作 |
|---|---|
| **approve** | 成果物を承認してループ終了 |
| **improve** | フィードバックを入力 → Manager が設定を改善して再調査 |
| **quit** | ループを中断 |

`improve` を選んでフィードバックを入力すると、その内容は Manager に直接届き、次のイテレーションの方針に反映されます。

ループ実行中（Worker 実行中・Manager 評価中・改善中を問わず）いつでも **Ctrl+X** を押すと割り込みダイアログが表示されます。

| 選択肢 | 動作 |
|---|---|
| **Stop and exit loop** | 現在のフェーズを中断してループ終了 |
| **Modify task instructions** | Worker への新しい指示を入力 → 次のイテレーションに反映 |
| **Ask manager a question** | Manager に質問する（Worker の作業は継続） |
| **Resume (cancel)** | 割り込みをキャンセルして作業を継続 |

調査中のタスク構造（L1〜L3 階層・TODO/DOING/DONE）は `workspace/task-plan.md` に随時更新されます。別ターミナルで `cat workspace/task-plan.md` を実行するか、Ctrl+X → 「Ask manager a question」で「現在の進捗を教えて」と質問することで確認できます。

## 自動化したい場合

Human Mode が基本ですが、完全自動に寄せたい場合は `.env` を設定できます。

```bash
cp .env.example .env
# .env を編集して必要な値を設定
```

SearXNG を使う場合や検索APIのフォールバックを設定したい場合は、`.env` で調整してください。`SEARCH_MODE=auto` を明示的に設定したときだけ自動モードになります。

### 例: 検索APIの設定

```bash
SEARCH_MODE=auto
SEARXNG_URL=http://localhost:8888
SEARCH_FALLBACK_PROVIDERS=tavily,brave,serper
TAVILY_API_KEY=tvly-...
BRAVE_API_KEY=...
SERPER_API_KEY=...
```

## プロジェクトのアーカイブとリセット

### シナリオ1: 調査が完了したとき

1. `npm run archive` を実行します。名前は自動で提案されます。

```text
提案名: "生成AI市場調査"
このまま使用しますか？ [Y/n/別名入力]
```

`Y` を押すか、別の名前を入力して Enter を押します。
2. `npm run new-project` を実行してワークスペースをリセットします。
3. `npm start` で次の調査を始められます。

### シナリオ2: 新しい調査を始めるとき

1. `npm run list-archives` で過去の調査一覧を確認します。

```text
# 日時・タスク名・最終スコア・イテレーション数が一覧表示される
```

2. `npm run new-project` でワークスペースをリセットします。現在の成果物が残っている場合は、先に `npm run archive` を実行してください。
3. `npm start` で起動し、新しい調査を依頼します。

### シナリオ3: 過去の調査を追加調査したいとき

コマンドは不要です。エージェントに自然な言葉で依頼するだけです。

1. `npm run list-archives` で対象の調査名を確認します。
2. `npm start` で起動し、次のように依頼します。

```text
「生成AI市場調査」の続きで、コスト比較の部分を追加調査してください
```

エージェントが自動でアーカイブを参照して調査を再開します。

### アーカイブの保存場所

アーカイブは `archives/{YYYY-MM-DD_HH-mm}_{name}/` に保存されます。`npm run list-archives` でいつでも一覧を確認できます。

## 開発者向け

仕組みをもっと深く知りたい場合は、次を参照してください。

- [Architecture Guide](docs/architecture.md)
- [API Reference](docs/api-reference.md)

## テスト

```bash
npm test
```
