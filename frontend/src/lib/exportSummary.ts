/**
 * Native meeting export pipeline.
 *
 * The webview creates format bytes, but the OS Save dialog owns destination
 * selection and grants the fs plugin access to that exact path. This avoids
 * browser-download behavior, which cannot reliably honor a requested folder in
 * a Tauri webview. Clipboard export is intentionally handled by the caller.
 */

import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import { jsPDF } from 'jspdf';
import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';

function sanitizeFilename(name: string): string {
  return (name || 'summary').replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'summary';
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

// ---------- DOCX ----------
async function createDocx(markdown: string): Promise<Uint8Array> {
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
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------- PDF ----------
function createPdf(markdown: string): Uint8Array {
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

  return new Uint8Array(doc.output('arraybuffer'));
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

// ---------- JSON ----------
function createJson(markdown: string, baseName: string): string {
  const payload = {
    app: 'Meetily - Actually Free',
    title: baseName,
    exportedAt: new Date().toISOString(),
    markdown,
    text: markdownToPlainText(markdown),
  };
  return JSON.stringify(payload, null, 2);
}

export type ExportFormat = 'markdown' | 'pdf' | 'docx' | 'json' | 'txt';

const FORMAT_DETAILS: Record<ExportFormat, { extension: string; label: string }> = {
  markdown: { extension: 'md', label: 'Markdown' },
  pdf: { extension: 'pdf', label: 'PDF' },
  docx: { extension: 'docx', label: 'Word document' },
  json: { extension: 'json', label: 'JSON' },
  txt: { extension: 'txt', label: 'Text' },
};

export async function exportSummaryAs(
  format: ExportFormat,
  markdown: string,
  baseName: string,
): Promise<boolean> {
  const details = FORMAT_DETAILS[format];
  // The native picker owns the destination and grants that selected path to
  // the fs plugin; the webview only creates bytes and never starts a download.
  const destination = await save({
    defaultPath: `${sanitizeFilename(baseName)}.${details.extension}`,
    filters: [{ name: details.label, extensions: [details.extension] }],
  });
  if (!destination) return false;
  const outputPath = destination.toLowerCase().endsWith(`.${details.extension}`)
    ? destination
    : `${destination}.${details.extension}`;

  const encoder = new TextEncoder();
  let bytes: Uint8Array;
  if (format === 'pdf') bytes = createPdf(markdown);
  else if (format === 'docx') bytes = await createDocx(markdown);
  else if (format === 'txt') bytes = encoder.encode(markdownToPlainText(markdown));
  else if (format === 'json') bytes = encoder.encode(createJson(markdown, baseName));
  else bytes = encoder.encode(markdown);

  await writeFile(outputPath, bytes);
  return true;
}
