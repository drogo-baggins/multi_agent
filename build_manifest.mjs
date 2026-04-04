import { writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const BUILD = 'workspace/output/combined_build';
const today = new Date().toISOString().slice(0, 10);

function fileInfo(path) {
  const s = statSync(path);
  const kb = Math.round(s.size / 1024);
  return { size: s.size, kb };
}

// manuscript.md
const ms = fileInfo(join(BUILD, 'manuscript.md'));

// svg_pdf
const svgFiles = readdirSync(join(BUILD, 'svg_pdf')).filter(f => f.endsWith('.pdf'));
let svgTable = svgFiles.map(f => {
  const info = fileInfo(join(BUILD, 'svg_pdf', f));
  return '| `svg_pdf/' + f + '` | ' + info.kb + ' KB |';
}).join('\n');

// xlsx_pdf
const xlsFiles = readdirSync(join(BUILD, 'xlsx_pdf')).filter(f => f.endsWith('.pdf'));
let xlsTable = xlsFiles.map(f => {
  const info = fileInfo(join(BUILD, 'xlsx_pdf', f));
  return '| `xlsx_pdf/' + f + '` | ' + info.kb + ' KB |';
}).join('\n');

const totalFiles = 1 + svgFiles.length + xlsFiles.length;
const svgTotalKB = svgFiles.reduce((acc, f) => acc + fileInfo(join(BUILD, 'svg_pdf', f)).kb, 0);
const xlsTotalKB = xlsFiles.reduce((acc, f) => acc + fileInfo(join(BUILD, 'xlsx_pdf', f)).kb, 0);
const grandTotalKB = ms.kb + svgTotalKB + xlsTotalKB;

const manifest = `# combined_build Manifest

> **生成日**: ${today}
> **格納先**: \`workspace/output/combined_build/\`
> **総ファイル数**: ${totalFiles} ファイル（manuscript.md + ${svgFiles.length} SVG-PDF + ${xlsFiles.length} Excel-PDF）
> **合計サイズ**: 約 ${grandTotalKB} KB

---

## ディレクトリ構造

\`\`\`
workspace/output/combined_build/
├── manuscript.md           # 全24レポート正規化・結合版（${ms.kb} KB / 17,800行）
├── svg_pdf/                # SVG図版 PDF変換（${svgFiles.length}ファイル）
│   ├── fig1-theme-relations.pdf
│   ├── fig1-inline.pdf
│   ├── fig2-3layer-model.pdf
│   ├── fig2-inline.pdf
│   ├── fig3-security.pdf
│   └── fig3-inline.pdf
└── xlsx_pdf/               # Excelファイル PDF変換（${xlsFiles.length}ファイル）
    ├── agents-md-full-spec.pdf
    ├── aider-opencode-copilot-rules-comparison.pdf
    ├── ...（全25ファイル）
    └── orchestrator-md-comparison.pdf
\`\`\`

---

## 1. manuscript.md

| 項目 | 値 |
|---|---|
| パス | \`manuscript.md\` |
| サイズ | ${ms.kb} KB |
| 行数 | 17,800行 |
| 結合レポート数 | 24本（report-*.md） + SUMMARY.md |
| 構成 | 第0部〜第6部 + 付録A〜E |
| 除外ファイル | report.md（J-1と重複）, report-arxiv-svg-c-style.md（スコープ外） |

### manuscript.md 章構成

| 章 | 内容 | 元ファイル |
|---|---|---|
| 第0部 | エグゼクティブサマリー・構造図 | INDEX-revised.md より抽出 |
| 第1部 | MDファイルハーネス仕様（静的制御） | A-1,A-2,A-3,B-1,C-1,C-2,F-1 |
| 第2部 | Hooks・ランタイム制御（動的制御） | D-1,I-1,I-2,I-3 |
| 第3部 | オーケストレーター動的MD生成 | H-1,H-2,H-3 |
| 第4部 | GitHub Copilot エコシステム | E-1,E-2,E-3,E-4,E-5,E-6 |
| 第5部 | Aider・opencode・OSS ツール | G-2,G-3 |
| 第6部 | コンテクストロット防止 | J-1 |
| 付録A | ハーネス設計 実務向け設計指針 | SUMMARY.md |
| 付録B | 補足Excelファイル一覧（25本） | INDEX-revised.md より抽出 |
| 付録C | 推奨読書順パス（6パス） | INDEX-revised.md より抽出 |
| 付録D | 重複・補完関係の整理 | INDEX-revised.md より抽出 |
| 付録E | 調査の制限事項 | INDEX-revised.md より抽出 |

---

## 2. SVG→PDF変換結果（6ファイル）

| ファイル | サイズ |
|---|---|
${svgTable}

**変換設定**: pdfkit + svg-to-pdfkit / A4横向き / viewBox自動スケール

---

## 3. Excel→PDF変換結果（25ファイル）

| ファイル | サイズ |
|---|---|
${xlsTable}

**変換設定**: ExcelJS（データ読み取り）+ pdfkit（表組みレンダリング） / A3横向き / 全シート出力
**フォント**: Helvetica（PDF標準埋め込みフォント）
**行高**: 14pt / フォントサイズ: 列数に応じて6〜8pt

---

## 4. 正規化・結合ルール（manuscript.md 生成）

| 処理 | 内容 |
|---|---|
| 見出しレベルシフト | 各レポートの h1→h3, h2→h4, h3→h5（+2シフト） |
| YAMLフロントマター除去 | 各レポート先頭の \`---...---\` ブロックを削除 |
| セクション区切り | \`<!-- ===... -->\` コメント + \`<a id="..."></a>\` アンカーを挿入 |
| 推奨版注記 | 前版ファイルには \`> **注記**: 参考・前版\` を付与 |
| G-1除外注記 | report.md は第5部冒頭に除外理由を記載 |
| 図版参照 | \`![figN](../../../output/svg/figN-xxx.svg)\` 形式で相対パス参照 |
| 付録 | INDEX-revised.md から各セクションを抽出・統合 |

---

## 5. 生成スクリプト

| スクリプト | 格納先 | 役割 |
|---|---|---|
| \`build_manuscript.mjs\` | multi-agent/ | manuscript.md 生成 |
| \`build_svg_pdf.mjs\` | multi-agent/ | SVG→PDF変換 |
| \`build_xlsx_pdf.mjs\` | multi-agent/ | Excel→PDF変換 |
| \`build_manifest.mjs\` | multi-agent/ | 本マニフェスト生成 |

---

*マニフェスト生成日: ${today}*
`;

writeFileSync(join(BUILD, 'MANIFEST.md'), manifest, 'utf8');
console.log('MANIFEST.md generated: ' + join(BUILD, 'MANIFEST.md'));
console.log('Total artifacts: ' + totalFiles + ' files (~' + grandTotalKB + ' KB)');
