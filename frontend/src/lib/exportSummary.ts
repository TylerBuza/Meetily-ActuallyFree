/**
 * Summary export helpers: Markdown, PDF, DOCX.
 *
 * Uses in-browser Blob downloads (the same approach the app already uses for Markdown),
 * so no extra Tauri fs/dialog permissions are required. Given a Markdown string, each
 * exporter produces a file and triggers a download.
 */

import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { jsPDF } from 'jspdf';

function sanitizeFilename(name: string): string {
  return (name || 'summary').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'summary';
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Split a markdown line into bold/plain runs based on **bold** markers. */
function parseInlineRuns(line: string): { text: string; bold: boolean }[] {
  const runs: { text: string; bold: boolean }[] = [];
  const parts = line.split(/(\*\*[^*]+\*\*)/g);
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**')) {
      runs.push({ text: part.slice(2, -2), bold: true });
    } else {
      runs.push({ text: part.replace(/\*\*/g, ''), bold: false });
    }
  }
  return runs.length ? runs : [{ text: line, bold: false }];
}

// ---------- Markdown ----------
export function exportMarkdown(markdown: string, baseName: string) {
  downloadBlob(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }), `${sanitizeFilename(baseName)}.md`);
}

// ---------- DOCX ----------
export async function exportDocx(markdown: string, baseName: string) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const paragraphs: Paragraph[] = [];

  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '');
    if (line.trim() === '' || line.trim() === '---') {
      paragraphs.push(new Paragraph({ children: [] }));
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = h[2].replace(/\*\*/g, '');
      const heading =
        level === 1 ? HeadingLevel.HEADING_1
        : level === 2 ? HeadingLevel.HEADING_2
        : level === 3 ? HeadingLevel.HEADING_3
        : HeadingLevel.HEADING_4;
      paragraphs.push(new Paragraph({ heading, children: [new TextRun({ text })] }));
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      paragraphs.push(
        new Paragraph({
          bullet: { level: 0 },
          children: parseInlineRuns(bullet[1]).map((r) => new TextRun({ text: r.text, bold: r.bold })),
        }),
      );
      continue;
    }
    paragraphs.push(
      new Paragraph({ children: parseInlineRuns(line).map((r) => new TextRun({ text: r.text, bold: r.bold })) }),
    );
  }

  const doc = new Document({ sections: [{ children: paragraphs }] });
  const blob = await Packer.toBlob(doc);
  downloadBlob(blob, `${sanitizeFilename(baseName)}.docx`);
}

// ---------- PDF ----------
export function exportPdf(markdown: string, baseName: string) {
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const marginX = 48;
  const marginTop = 56;
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const maxWidth = pageWidth - marginX * 2;
  let y = marginTop;

  const ensureSpace = (lineHeight: number) => {
    if (y + lineHeight > pageHeight - marginTop) {
      doc.addPage();
      y = marginTop;
    }
  };

  const writeWrapped = (text: string, size: number, bold: boolean, gapAfter = 4, indent = 0) => {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    const wrapped = doc.splitTextToSize(text, maxWidth - indent);
    const lineHeight = size * 1.25;
    for (const w of wrapped) {
      ensureSpace(lineHeight);
      doc.text(w, marginX + indent, y);
      y += lineHeight;
    }
    y += gapAfter;
  };

  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\s+$/g, '');
    if (line.trim() === '') { y += 6; continue; }
    if (line.trim() === '---') { ensureSpace(10); doc.setDrawColor(200); doc.line(marginX, y, pageWidth - marginX, y); y += 12; continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const size = level === 1 ? 20 : level === 2 ? 16 : level === 3 ? 13 : 12;
      writeWrapped(h[2].replace(/\*\*/g, ''), size, true, 6);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      writeWrapped('•  ' + bullet[1].replace(/\*\*/g, ''), 11, false, 2, 10);
      continue;
    }
    writeWrapped(line.replace(/\*\*/g, ''), 11, false, 4);
  }

  doc.save(`${sanitizeFilename(baseName)}.pdf`);
}

// ---------- Plain text ----------
export function markdownToPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/^#{1,6}\s+/gm, '')      // headings
    .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
    .replace(/\*([^*]+)\*/g, '$1')     // italics
    .replace(/`([^`]+)`/g, '$1')       // inline code
    .replace(/^\s*[-*]\s+/gm, '• ')    // bullets
    .replace(/^\s*---\s*$/gm, '----------')
    .trim();
}

export function exportTxt(markdown: string, baseName: string) {
  downloadBlob(new Blob([markdownToPlainText(markdown)], { type: 'text/plain;charset=utf-8' }), `${sanitizeFilename(baseName)}.txt`);
}

// ---------- JSON ----------
export function exportJson(markdown: string, baseName: string) {
  const payload = {
    app: 'Meetily - Actually Free',
    title: baseName,
    exportedAt: new Date().toISOString(),
    markdown,
    text: markdownToPlainText(markdown),
  };
  downloadBlob(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' }), `${sanitizeFilename(baseName)}.json`);
}

export type ExportFormat = 'markdown' | 'pdf' | 'docx' | 'json' | 'txt';

export async function exportSummaryAs(format: ExportFormat, markdown: string, baseName: string) {
  if (format === 'markdown') return exportMarkdown(markdown, baseName);
  if (format === 'pdf') return exportPdf(markdown, baseName);
  if (format === 'docx') return exportDocx(markdown, baseName);
  if (format === 'json') return exportJson(markdown, baseName);
  if (format === 'txt') return exportTxt(markdown, baseName);
}
