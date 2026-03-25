# Excel出力スキル

表形式データを `.xlsx` ファイルとして `output/` に保存する。

## 使用条件

- 比較表、製品一覧、価格表など、列が多くマークダウン表では視認性が低いデータ
- レポートに補足資料として添付したい構造化データ

## 基本パターン

```bash
node --input-type=module << 'SCRIPT'
import ExcelJS from 'exceljs';
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('シート名');

ws.addRow(['列1', '列2', '列3']);
ws.addRow(['値A', 100, 'https://example.com']);
ws.addRow(['値B', 200, 'https://example.org']);

await wb.xlsx.writeFile('output/result.xlsx');
SCRIPT
```

## 複数シートパターン

```bash
node --input-type=module << 'SCRIPT'
import ExcelJS from 'exceljs';
const wb = new ExcelJS.Workbook();

const ws1 = wb.addWorksheet('概要');
ws1.addRow(['項目', '値']);
ws1.addRow(['総件数', 42]);

const ws2 = wb.addWorksheet('詳細');
ws2.addRow(['名称', '価格', '出典URL']);
ws2.addRow(['製品A', 1000, 'https://...']);

await wb.xlsx.writeFile('output/result.xlsx');
SCRIPT
```

## ヘッダー行の太字化

```bash
node --input-type=module << 'SCRIPT'
import ExcelJS from 'exceljs';
const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('データ');

ws.addRow(['名称', '価格', 'カテゴリ']);
ws.getRow(1).font = { bold: true };

ws.addRow(['製品A', 1000, 'Electronics']);

await wb.xlsx.writeFile('output/result.xlsx');
SCRIPT
```

## 注意事項

- ヒアドキュメントの終端 `SCRIPT` の前に空白を入れない
- 文字列・数値・URLはそのままセルに入れるだけでExcelが型を解釈する
- ファイルパスは必ず `output/` 配下を指定する
- 生成後、`output/report.md` に `output/result.xlsx` への言及を追記する
