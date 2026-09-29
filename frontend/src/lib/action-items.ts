/**
 * Turns the "Action items" part of an AI summary into structured items.
 *
 * The meeting keeps action items as rows (checkable, owned, linked to people),
 * so the summary text should not repeat them. `extractActionItems` returns the
 * items plus the summary with those sections removed. When a section cannot
 * be recognised (custom or non-English headings) the summary is left intact:
 * nothing is ever dropped silently.
 *
 * Pure functions, unit tested in tests/lib/action-items.test.ts.
 */

export interface ExtractedDraft {
  text: string;
  ownerLabel: string | null;
  dueText: string | null;
}

export interface ExtractionResult {
  drafts: ExtractedDraft[];
  /** The summary without its action sections (unchanged if none were found). */
  remainingMarkdown: string;
  /** True when at least one action section was recognised. */
  hadActionSection: boolean;
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const BOLD_HEADING_RE = /^\*\*(.+?)\*\*:?\s*$/;
const ACTION_HEADING_RE =
  /^(?:key |open |proposed |agreed |the )?(?:action items?|actions|action points?|next steps?|to-?dos?|todo list|follow[- ]?ups?|follow[- ]?up items|tasks|assignments|deliverables|commitments)(?:\s*(?:and|&|\/)\s*(?:owners?|deadlines?|due dates?|next steps?|follow[- ]?ups?))?$/;
const NONE_RE = /^(?:none|n\/a|no (?:action items?|actions|tasks|follow[- ]?ups?|next steps)\b.*)$/i;

/** Normalises a heading for matching: no numbering, emoji, punctuation, or asides. */
export function normalizeHeading(raw: string): string {
  return raw
    .replace(/\*\*|__|`/g, '')
    .replace(/\([^)]*\)/g, '')
    .replace(/^[\s\d.)-]+/, '')
    .replace(/[\p{Extended_Pictographic}️]/gu, '')
    .replace(/[:：]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function isActionHeading(raw: string): boolean {
  return ACTION_HEADING_RE.test(normalizeHeading(raw));
}

interface Heading {
  level: number;
  text: string;
}

function headingOf(line: string): Heading | null {
  const hash = HEADING_RE.exec(line.trim());
  if (hash) return { level: hash[1].length, text: hash[2] };
  const bold = BOLD_HEADING_RE.exec(line.trim());
  // A bold-only line acts as a heading one level below the deepest level.
  if (bold) return { level: 7, text: bold[1] };
  return null;
}

function stripInline(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\\.?';
const DUE_PATTERNS = [
  new RegExp(`\\(?\\s*(?:due|by|before|deadline:?)\\s+((?:${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s*\\d{4})?)|\\d{4}-\\d{2}-\\d{2}|(?:next\\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|week|month)|tomorrow|today|tonight|eod|eow|end of (?:day|week|month))\\s*\\)?\\.?$`, 'i'),
  /\(\s*((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|tomorrow|today|eod|eow)\s*\)\.?$/i,
];

/** Pulls an owner and a due date out of one action line. */
export function parseActionLine(raw: string): ExtractedDraft {
  let text = stripInline(raw.replace(/^\s*(?:[-*+•]|\d+[.)])\s+/, '').replace(/^\[[ xX]\]\s*/, ''));
  let ownerLabel: string | null = null;
  let dueText: string | null = null;

  let match = /^@([\p{L}][\p{L}.'’-]*(?:\s+[\p{Lu}][\p{L}.'’-]*)?)\s*[:,-]?\s+(.+)$/u.exec(text);
  if (match) {
    ownerLabel = match[1];
    text = match[2];
  }
  if (!ownerLabel) {
    match = /^(you|me)\s*[:\-–—]\s+(.+)$/i.exec(text);
    if (match) {
      ownerLabel = 'You';
      text = match[2];
    }
  }
  if (!ownerLabel) {
    match = /^\[([^\]]{1,40})\]\s*[:\-–—]?\s*(.+)$/.exec(text);
    if (match) {
      ownerLabel = match[1].trim();
      text = match[2];
    }
  }
  if (!ownerLabel) {
    match = /^([\p{Lu}][\p{L}.'’-]+(?:\s+[\p{Lu}][\p{L}.'’-]+){0,2})\s*(?::|\s[–—-])\s+(.+)$/u.exec(text);
    if (match && !/^(note|update|decision|summary|context|background)$/i.test(match[1])) {
      ownerLabel = match[1];
      text = match[2];
    }
  }
  if (!ownerLabel) {
    match = /\s*[(\[]?\s*(?:owner|assignee|assigned to|owned by)\s*[:\-]?\s*([\p{Lu}][\p{L}.'’-]+(?:\s+[\p{Lu}][\p{L}.'’-]+)?)\s*[)\]]?/iu.exec(text);
    if (match) {
      ownerLabel = match[1];
      text = text.replace(match[0], ' ');
    }
  }

  for (const pattern of DUE_PATTERNS) {
    const due = pattern.exec(text);
    if (due) {
      dueText = due[1].trim();
      text = text.slice(0, due.index);
      break;
    }
  }
  text = text.replace(/[\s,;–—-]+$/, '').replace(/\s{2,}/g, ' ').trim();
  if (/^you$/i.test(ownerLabel ?? '')) ownerLabel = 'You';
  return { text, ownerLabel, dueText };
}

function splitRow(row: string): string[] {
  let body = row.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  // `\|` is a literal pipe inside a cell, not a column break.
  return body.split(/(?<!\\)\|/).map((cell) => stripInline(cell.replace(/\\\|/g, '|')));
}

const isSeparator = (cells: string[]) => cells.every((cell) => cell === '' || /^:?-{2,}:?$/.test(cell.replace(/\s/g, '')));

function parseTable(rows: string[]): ExtractedDraft[] {
  const grid = rows.map(splitRow).filter((cells) => cells.some((cell) => cell !== ''));
  if (grid.length === 0) return [];
  const header = grid[0].map((cell) => cell.toLowerCase());
  const find = (re: RegExp) => header.findIndex((cell) => re.test(cell));
  const ownerAt = find(/owner|assignee|assigned|who|responsible/);
  const taskAt = find(/task|action|item|descr|to-?do|deliverable|what|next/);
  const dueAt = find(/due|date|when|deadline|timeline|by/);
  const hasHeader = ownerAt >= 0 || taskAt >= 0 || dueAt >= 0;

  const drafts: ExtractedDraft[] = [];
  for (const cells of grid.slice(hasHeader ? 1 : 0)) {
    if (isSeparator(cells)) continue;
    const pick = (index: number) => (index >= 0 ? (cells[index] ?? '').trim() : '');
    let task = pick(taskAt);
    if (!task) {
      task = cells
        .filter((cell, index) => cell && index !== ownerAt && index !== dueAt)
        .sort((a, b) => b.length - a.length)[0] ?? '';
    }
    if (!task || /^[-–—]$/.test(task)) continue;
    const owner = pick(ownerAt);
    const due = pick(dueAt);
    drafts.push({
      text: task,
      ownerLabel: owner && !/^[-–—]|tbd|n\/a$/i.test(owner) ? owner : null,
      dueText: due && !/^[-–—]|tbd|n\/a$/i.test(due) ? due : null,
    });
  }
  return drafts;
}

function parseSectionBody(lines: string[]): { drafts: ExtractedDraft[]; recognised: boolean } {
  const drafts: ExtractedDraft[] = [];
  const tableRows: string[] = [];
  let sawNone = false;

  const flushTable = () => {
    if (tableRows.length > 0) {
      drafts.push(...parseTable(tableRows));
      tableRows.length = 0;
    }
  };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushTable();
      continue;
    }
    if (line.trim().startsWith('|')) {
      tableRows.push(line);
      continue;
    }
    flushTable();
    const trimmed = line.trim();
    if (/^[-=*_]{3,}$/.test(trimmed)) continue;
    const indented = /^(\s{2,}|\t)[-*+•]|^(\s{2,}|\t)\d+[.)]/.test(line);
    const content = stripInline(trimmed.replace(/^(?:[-*+•]|\d+[.)])\s+/, ''));
    if (NONE_RE.test(content.replace(/\.$/, ''))) {
      sawNone = true;
      continue;
    }
    if (indented && drafts.length > 0) {
      // Sub-points read as detail on the item above them.
      const parent = drafts[drafts.length - 1];
      parent.text = `${parent.text}; ${content}`.replace(/\s{2,}/g, ' ');
      continue;
    }
    const draft = parseActionLine(trimmed);
    if (draft.text) drafts.push(draft);
  }
  flushTable();
  return { drafts, recognised: drafts.length > 0 || sawNone };
}

/**
 * Extracts every recognised action section. A section runs from its heading
 * to the next heading at the same or a higher level.
 */
export function extractActionItems(markdown: string): ExtractionResult {
  const lines = (markdown ?? '').split(/\r?\n/);
  const drafts: ExtractedDraft[] = [];
  const keep: boolean[] = lines.map(() => true);
  let hadActionSection = false;

  for (let index = 0; index < lines.length; index++) {
    const heading = headingOf(lines[index]);
    if (!heading || !isActionHeading(heading.text)) continue;

    let end = index + 1;
    while (end < lines.length) {
      const next = headingOf(lines[end]);
      if (next && next.level <= heading.level) break;
      // A bold pseudo-heading ends at any markdown heading.
      if (next && heading.level === 7) break;
      end++;
    }
    const section = parseSectionBody(lines.slice(index + 1, end));
    if (!section.recognised) continue;
    hadActionSection = true;
    drafts.push(...section.drafts);
    for (let cursor = index; cursor < end; cursor++) keep[cursor] = false;
    index = end - 1;
  }

  const remainingMarkdown = hadActionSection
    ? lines
        .filter((_, index) => keep[index])
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    : markdown;

  const seen = new Set<string>();
  const unique = drafts.filter((draft) => {
    const key = draft.text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { drafts: unique, remainingMarkdown, hadActionSection };
}

/** Small stable fingerprint (FNV-1a) of a summary text. */
export function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}-${text.length}`;
}

const STOP = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'will', 'into', 'about', 'their', 'there', 'have', 'has',
  'our', 'your', 'you', 'send', 'make', 'get', 'set', 'up', 'out', 'to', 'of', 'on', 'in', 'by', 'a', 'an', 'is',
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 2 && !STOP.has(word));
}

/**
 * Best guess for where in the meeting an item was discussed: the transcript
 * line sharing the most meaningful words with it (at least three, and at
 * least half of the item's words), or null when nothing matches well.
 */
export function locateInTranscript(
  text: string,
  segments: Array<{ id: string; timestamp: number; text: string }>,
): { audioTime: number; transcriptId: string } | null {
  const target = new Set(words(text));
  if (target.size === 0) return null;
  let best: { score: number; audioTime: number; transcriptId: string } | null = null;
  for (const segment of segments) {
    const overlap = new Set(words(segment.text).filter((word) => target.has(word))).size;
    if (!best || overlap > best.score) {
      best = { score: overlap, audioTime: segment.timestamp, transcriptId: segment.id };
    }
  }
  if (!best || best.score < 3 || best.score < target.size / 2) return null;
  return { audioTime: best.audioTime, transcriptId: best.transcriptId };
}
