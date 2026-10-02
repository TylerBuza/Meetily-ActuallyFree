/** Saved-summary classification for expandable All meetings previews. */
export type Bucket = 'summary' | 'actions' | 'topics' | 'insights';

const RE = {
  actions: /(action|task|to-?do|next[ -]?step|follow[ -]?up|deliverable)/i,
  topics: /(topic|theme|discuss|agenda|subject)/i,
  summary: /(summary|overview|abstract|tl;?dr|key[ -]?point|highlight|recap)/i,
  insights: /(insight|decision|risk|take[ -]?away|conclusion|outcome|blocker|learn)/i,
};

function classify(h: string): Bucket {
  if (RE.actions.test(h)) return 'actions';
  if (RE.topics.test(h)) return 'topics';
  if (RE.summary.test(h)) return 'summary';
  if (RE.insights.test(h)) return 'insights';
  return 'insights';
}

export function inlineText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(inlineText).join('');
  if (typeof node === 'object') {
    if (typeof node.text === 'string') return node.text;
    if (node.content) return inlineText(node.content);
  }
  return '';
}

export function blocksToMarkdown(blocks: any[]): string {
  const out: string[] = [];
  const walk = (list: any[]) => {
    for (const b of list || []) {
      const text = inlineText(b?.content).trim();
      const type = b?.type;
      if (type === 'heading') out.push(`## ${text}`);
      else if (type === 'bulletListItem' || type === 'numberedListItem' || type === 'checkListItem') out.push(`- ${text}`);
      else if (text) out.push(text);
      if (Array.isArray(b?.children) && b.children.length) walk(b.children);
    }
  };
  walk(blocks);
  return out.join('\n');
}

function headingOf(line: string): string | null {
  let m = line.match(/^#{1,6}\s+(.*)$/); if (m) return m[1].replace(/[:*]+$/, '').trim();
  m = line.match(/^\*\*(.+?)\*\*:?\s*$/); if (m) return m[1].trim();
  m = line.match(/^([A-Z][A-Za-z /&]{2,40}):\s*$/); if (m) return m[1].trim();
  return null;
}

function parseMarkdownBuckets(md: string): Record<Bucket, string[]> {
  const out: Record<Bucket, string[]> = { summary: [], actions: [], topics: [], insights: [] };
  let current: Bucket = 'summary';
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^[-=*_]{3,}$/.test(line)) continue;
    const h = headingOf(line);
    if (h) { current = classify(h); continue; }
    const item = line.replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '').replace(/^#+\s*/, '').trim();
    if (item) out[current].push(item);
  }
  return out;
}

function bucketizeSections(summary: any): Record<Bucket, string[]> {
  const out: Record<Bucket, string[]> = { summary: [], actions: [], topics: [], insights: [] };
  const leftovers: string[] = [];
  const skip = new Set(['markdown', 'summary_json', '_section_order', 'MeetingName']);
  for (const [key, section] of Object.entries(summary)) {
    if (skip.has(key) || !section || !Array.isArray((section as any).blocks)) continue;
    const items = (section as any).blocks.map((b: any) => (b?.content ?? '').trim()).filter(Boolean);
    if (items.length === 0) continue;
    const label = `${key} ${(section as any).title ?? ''}`;
    if (RE.actions.test(label)) out.actions.push(...items);
    else if (RE.topics.test(label)) out.topics.push(...items);
    else if (RE.summary.test(label)) out.summary.push(...items);
    else if (RE.insights.test(label)) out.insights.push(...items);
    else leftovers.push(...items);
  }
  out.insights.push(...leftovers);
  if (out.summary.length === 0) out.summary = (leftovers.length ? leftovers : out.insights).slice(0, 4);
  return out;
}

export function normalizeSummary(aiSummary: any): Record<Bucket, string[]> {
  if (!aiSummary) return { summary: [], actions: [], topics: [], insights: [] };
  if (typeof aiSummary === 'string') {
    const trimmed = aiSummary.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"')) {
      try { return normalizeSummary(JSON.parse(trimmed)); } catch { /* plain Markdown */ }
    }
    return parseMarkdownBuckets(aiSummary);
  }
  if (Array.isArray(aiSummary)) return parseMarkdownBuckets(blocksToMarkdown(aiSummary));
  if (typeof aiSummary.markdown === 'string') return parseMarkdownBuckets(aiSummary.markdown);
  if (Array.isArray(aiSummary.summary_json)) return parseMarkdownBuckets(blocksToMarkdown(aiSummary.summary_json));
  return bucketizeSections(aiSummary);
}

/** Topic bullets often contain a bold short label followed by an explanation. */
export function shortTopicLabel(raw: string): string {
  const topic = raw.replace(/^\s*(?:[-*+•]\s+)?/, '').trim();
  const boldLabel = topic.match(/^\*\*(.{1,60}?)\*\*\s*[:\-–—]?/);
  if (boldLabel) return boldLabel[1].replace(/[:\s]+$/, '').trim();
  const colon = topic.indexOf(':');
  if (colon > 0 && colon <= 40) return topic.slice(0, colon).replace(/[*_`]/g, '').trim();
  const plain = topic.replace(/[*_`]/g, '').trim();
  return plain.length > 40 ? `${plain.slice(0, 38).trim()}…` : plain;
}
