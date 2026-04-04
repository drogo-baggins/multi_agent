import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, basename, extname } from 'path';
import PDFDocument from 'pdfkit';
import SVGtoPDF from 'svg-to-pdfkit';

const SVG_DIR  = 'workspace/output/svg';
const OUT_DIR  = 'workspace/output/combined_build/svg_pdf';
mkdirSync(OUT_DIR, { recursive: true });

const svgFiles = [
  'fig1-theme-relations.svg',
  'fig1-inline.svg',
  'fig2-3layer-model.svg',
  'fig2-inline.svg',
  'fig3-security.svg',
  'fig3-inline.svg',
];

const results = [];

for (const svgFile of svgFiles) {
  const svgPath = join(SVG_DIR, svgFile);
  const pdfName = svgFile.replace('.svg', '.pdf');
  const pdfPath = join(OUT_DIR, pdfName);

  try {
    const svgContent = readFileSync(svgPath, 'utf8');

    // SVGのviewBox/width/heightから寸法を取得
    const wMatch = svgContent.match(/width="([^"]+)"/);
    const hMatch = svgContent.match(/height="([^"]+)"/);
    const vbMatch = svgContent.match(/viewBox="([^"]+)"/);

    let pageWidth = 842;  // A4 landscape points
    let pageHeight = 595;

    if (vbMatch) {
      const vb = vbMatch[1].split(/[\s,]+/).map(Number);
      if (vb.length >= 4 && vb[2] > 0 && vb[3] > 0) {
        // アスペクト比を保ちつつA4に収める
        const svgW = vb[2];
        const svgH = vb[3];
        const scale = Math.min(842 / svgW, 595 / svgH);
        pageWidth  = Math.round(svgW * scale);
        pageHeight = Math.round(svgH * scale);
      }
    }

    const doc = new PDFDocument({
      size: [pageWidth, pageHeight],
      margin: 0,
      info: {
        Title: svgFile.replace('.svg', ''),
        Author: 'Worker Agent',
        Subject: 'AIコーディングエージェント 調査レポート 図版',
        CreationDate: new Date(),
      }
    });

    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));

    await new Promise((resolve, reject) => {
      doc.on('end', resolve);
      doc.on('error', reject);
      try {
        SVGtoPDF(doc, svgContent, 0, 0, {
          width: pageWidth,
          height: pageHeight,
          preserveAspectRatio: 'xMidYMid meet',
        });
        doc.end();
      } catch (e) {
        reject(e);
      }
    });

    writeFileSync(pdfPath, Buffer.concat(chunks));
    const kb = Math.round(Buffer.concat(chunks).length / 1024);
    console.log('OK  ' + pdfName + ' (' + kb + ' KB)');
    results.push({ file: pdfName, status: 'ok', kb });
  } catch (err) {
    console.error('ERR ' + svgFile + ': ' + err.message);
    results.push({ file: pdfName, status: 'error', error: err.message });
  }
}

console.log('\nSVG->PDF conversion summary:');
console.log('Success: ' + results.filter(r => r.status === 'ok').length + '/' + svgFiles.length);
results.forEach(r => console.log('  ' + (r.status === 'ok' ? '[OK]' : '[NG]') + ' ' + r.file));
