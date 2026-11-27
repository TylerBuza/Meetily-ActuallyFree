/** Exported document content: section headings and labels written into PDF, Word, Markdown and text exports. */
const exportDoc = {
  // Headings written into a meeting's exported document.
  notesHeading: 'Your notes',
  actionItemsHeading: 'Action items',
  summaryHeading: 'AI summary',
  transcriptHeading: 'Transcript',
  // Single-meeting copy/export path (currently localized via feedback.*); the
  // heading it writes is "Summary", not the multi-meeting export's "AI summary".
  summarySectionHeading: 'Summary',

  // Names shown for the file formats in the native Save dialog's filter list.
  formatMarkdown: 'Markdown',
  formatPdf: 'PDF',
  formatWordDocument: 'Word document',
  formatJson: 'JSON',
  formatText: 'Text',
} as const

export default exportDoc
