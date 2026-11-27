import type { Messages } from '../en'

/** 简体中文：导出文档内容（PDF、Word、Markdown 与纯文本中的标题与标签）。 */
const exportDoc: Messages['exportDoc'] = {
  // 写入导出文档的章节标题。
  notesHeading: '你的笔记',
  actionItemsHeading: '行动项',
  summaryHeading: 'AI 摘要',
  transcriptHeading: '转写内容',
  // 单会议复制/导出路径（目前由 feedback.* 本地化）的标题；其文档中为“摘要”，而非“AI 摘要”。
  summarySectionHeading: '摘要',

  // 系统保存对话框文件类型列表中的格式名称。
  formatMarkdown: 'Markdown',
  formatPdf: 'PDF',
  formatWordDocument: 'Word 文档',
  formatJson: 'JSON',
  formatText: '文本',
}

export default exportDoc
