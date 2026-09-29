/**
 * Summaries are stored as markdown, as BlockNote JSON, or (older meetings) as
 * a map of titled sections. These helpers flatten any of them to markdown.
 */

function inlineText(node: unknown): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(inlineText).join('');
  if (typeof node === 'object') {
    const value = node as { text?: unknown; content?: unknown };
    if (typeof value.text === 'string') return value.text;
    if (value.content) return inlineText(value.content);
  }
  return '';
}

export function blocksToMarkdown(blocks: unknown[]): string {
  const out: string[] = [];
  const walk = (list: unknown[], depth: number) => {
    for (const raw of list || []) {
      const block = raw as { type?: string; content?: unknown; children?: unknown[]; props?: { level?: number; checked?: boolean } };
      const text = inlineText(block?.content).trim();
      const indent = '  '.repeat(depth);
      switch (block?.type) {
        case 'heading':
          out.push(`${'#'.repeat(Math.min(6, Math.max(1, block.props?.level ?? 2)))} ${text}`);
          break;
        case 'bulletListItem':
          out.push(`${indent}- ${text}`);
          break;
        case 'numberedListItem':
          out.push(`${indent}1. ${text}`);
          break;
        case 'checkListItem':
          out.push(`${indent}- [${block.props?.checked ? 'x' : ' '}] ${text}`);
          break;
        case 'quote':
          if (text) out.push(`> ${text}`);
          break;
        case 'table': {
          const rows = (block.content as { rows?: Array<{ cells?: unknown[] }> } | undefined)?.rows;
          if (!Array.isArray(rows) || rows.length === 0) break;
          const cells = rows.map((row) =>
            (Array.isArray(row?.cells) ? row.cells : []).map((cell) => {
              const value = cell as { content?: unknown } | unknown[];
              return inlineText(Array.isArray(value) ? value : value?.content).trim().replace(/\|/g, '\\|');
            }),
          );
          const width = Math.max(1, ...cells.map((row) => row.length));
          const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? '').join(' | ')} |`;
          out.push(line(cells[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...cells.slice(1).map(line));
          break;
        }
        default:
          if (text) out.push(text);
      }
      if (Array.isArray(block?.children) && block.children.length) walk(block.children, depth + 1);
    }
  };
  walk(blocks, 0);
  return out.join('\n');
}

/** The complete, user-visible summary as markdown, whatever format it is stored in. */
export function completeSummaryMarkdown(summary: unknown): string {
  if (!summary) return '';
  if (typeof summary === 'string') return summary;
  const value = summary as Record<string, any>;
  if (typeof value.markdown === 'string') return value.markdown;
  if (Array.isArray(value.summary_json)) return blocksToMarkdown(value.summary_json);
  const keys = [...new Set([...(Array.isArray(value._section_order) ? value._section_order : []), ...Object.keys(value)])];
  return keys
    .flatMap((key) => {
      if (key === 'english_cache' || key === 'original_markdown') return [];
      const section = value[key];
      if (!Array.isArray(section?.blocks)) return [];
      return [`## ${section.title || key}\n\n${section.blocks.map((block: any) => inlineText(block.content)).join('\n\n')}`];
    })
    .join('\n\n');
}

/** api_get_summary may return its data double-encoded. */
export function parseSummaryData(data: unknown): Record<string, any> | null {
  if (!data) return null;
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' ? parsed : { markdown: data };
    } catch {
      return { markdown: data };
    }
  }
  return typeof data === 'object' ? (data as Record<string, any>) : null;
}
