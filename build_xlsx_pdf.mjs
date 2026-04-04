import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';

const XLS_DIR = 'workspace/output';
const OUT_DIR = 'workspace/output/combined_build/xlsx_pdf';
mkdirSync(OUT_DIR, { recursive: true });

const xlsxFiles = [
  'agents-md-full-spec.xlsx',
  'aider-opencode-copilot-rules-comparison.xlsx',
  'claude-md-full-spec.xlsx',
  'coding-agents-architecture-comparison.xlsx',
  'coding-agents-comparison.xlsx',
  'context-rot-impl.xlsx',
  'copilot-agent-mode-ide.xlsx',
  'copilot-coding-agent-comparison.xlsx',
  'copilot-coding-agent-pr.xlsx',
  'copilot-extensions-mcp-policy.xlsx',
  'copilot-harness-comparison.xlsx',
  'copilot-instructions-agents-spec.xlsx',
  'cursor-cline-rules-comparison.xlsx',
  'dynamic-md-control-patterns.xlsx',
  'github-copilot-agent-comparison.xlsx',
  'hooks-a2a-mcp-runtime-control.xlsx',
  'hooks-codex-rules-comparison.xlsx',
  'hooks-runtime-control-comparison.xlsx',
  'md-harness-agentsystem-comparison.xlsx',
  'md-harness-comparison.xlsx',
  'md-harness-specs-final.xlsx',
  'md-harness-specs.xlsx',
  'openai-agents-orchestrator.xlsx',
  'orchestrator-dynamic-md-patterns.xlsx',
  'orchestrator-md-comparison.xlsx',
];

// ExcelJSでシートデータを読み取り、PDFDocumentで表組みレンダリング
async function xlsxToPdf(xlsxPath, pdfPath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsxPath);

  const doc = new PDFDocument({
    size: 'A3',
    layout: 'landscape',
    margin: 30,
    info: {
      Title: xlsxPath,
      Author: 'Worker Agent',
      Subject: 'AIコーディングエージェント 調査レポート 補足データ',
      CreationDate: new Date(),
    }
  });

  const chunks = [];
  doc.on('data', c => chunks.push(c));

  const FONT_REGULAR = 'Helvetica';
  const FONT_BOLD    = 'Helvetica-Bold';
  const PAGE_W = doc.page.width  - 60;  // margin*2
  const PAGE_H = doc.page.height - 60;

  let firstSheet = true;

  wb.eachSheet((ws) => {
    if (!firstSheet) doc.addPage({ size: 'A3', layout: 'landscape', margin: 30 });
    firstSheet = false;

    // シートタイトル
    doc.font(FONT_BOLD).fontSize(11).text(ws.name, { underline: true });
    doc.moveDown(0.3);

    // 全行データ収集
    const rows = [];
    ws.eachRow((row, rowNum) => {
      const cells = [];
      row.eachCell({ includeEmpty: true }, (cell) => {
        let v = '';
        if (cell.value !== null && cell.value !== undefined) {
          if (typeof cell.value === 'object' && cell.value.text) {
            v = String(cell.value.text);
          } else if (typeof cell.value === 'object' && cell.value.result !== undefined) {
            v = String(cell.value.result);
          } else {
            v = String(cell.value);
          }
        }
        cells.push(v);
      });
      rows.push(cells);
    });

    if (rows.length === 0) {
      doc.font(FONT_REGULAR).fontSize(8).text('(empty sheet)');
      return;
    }

    // 列数
    const colCount = Math.max(...rows.map(r => r.length));
    if (colCount === 0) return;

    // 列幅: 均等分割（最大列数に応じて）
    const colW = Math.max(40, Math.floor(PAGE_W / colCount));
    const rowH = 14;
    const fontSize = colCount > 8 ? 6 : colCount > 5 ? 7 : 8;

    let y = doc.y;
    const startX = doc.page.margins.left;

    rows.forEach((row, ri) => {
      // ページ超えチェック
      if (y + rowH > PAGE_H + 30) {
        doc.addPage({ size: 'A3', layout: 'landscape', margin: 30 });
        doc.font(FONT_BOLD).fontSize(9).text(ws.name + ' (続き)', { underline: false });
        doc.moveDown(0.2);
        y = doc.y;
      }

      const isHeader = ri === 0;
      if (isHeader) {
        doc.rect(startX, y, Math.min(colW * colCount, PAGE_W), rowH).fill('#4472C4');
      }

      row.forEach((cell, ci) => {
        const x = startX + ci * colW;
        if (x + colW > startX + PAGE_W + 5) return;  // 列はみ出し防止

        // セル枠
        doc.rect(x, y, colW, rowH)
           .stroke(isHeader ? '#2F5496' : '#CCCCCC');

        // テキスト
        const textColor = isHeader ? 'white' : 'black';
        doc.font(isHeader ? FONT_BOLD : FONT_REGULAR)
           .fontSize(fontSize)
           .fillColor(textColor)
           .text(
             cell.substring(0, 80),  // 長すぎるテキストは切り詰め
             x + 2, y + 2,
             { width: colW - 4, height: rowH - 2, lineBreak: false, ellipsis: true }
           );
      });

      y += rowH;
    });

    doc.y = y + 5;
  });

  doc.end();

  await new Promise(resolve => doc.on('end', resolve));
  const buf = Buffer.concat(chunks);
  writeFileSync(pdfPath, buf);
  return buf.length;
}

// 全ファイルを順次変換
const results = [];
for (const fname of xlsxFiles) {
  const xlsxPath = join(XLS_DIR, fname);
  const pdfName  = fname.replace('.xlsx', '.pdf');
  const pdfPath  = join(OUT_DIR, pdfName);
  try {
    const bytes = await xlsxToPdf(xlsxPath, pdfPath);
    const kb = Math.round(bytes / 1024);
    console.log('OK  ' + pdfName + ' (' + kb + ' KB)');
    results.push({ file: pdfName, status: 'ok', kb });
  } catch (err) {
    console.error('ERR ' + fname + ': ' + err.message);
    results.push({ file: pdfName, status: 'error', error: err.message });
  }
}

const ok  = results.filter(r => r.status === 'ok').length;
const err = results.filter(r => r.status === 'error').length;
console.log('\nExcel->PDF conversion summary:');
console.log('Success: ' + ok + '/' + xlsxFiles.length + (err > 0 ? '  Errors: ' + err : ''));
results.forEach(r => console.log('  ' + (r.status === 'ok' ? '[OK]' : '[NG]') + ' ' + r.file + (r.error ? ' - ' + r.error : '')));
