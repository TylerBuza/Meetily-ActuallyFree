"use client";

/**
 * Meeting-details right panel. A single scrolling column — AI Summary, Action
 * Items, Key Topics — with an Ask-AI box pinned at the bottom, grounded in the
 * meeting transcript.
 *
 * The stored summary can arrive as markdown, BlockNote JSON, or a legacy section
 * map; all three are flattened into the same buckets so the panel renders
 * regardless of which the backend/model produced. Owners and due dates on action
 * items are recovered heuristically from the item text.
 */

import { useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Sparkles,
  Copy,
  RefreshCw,
  ThumbsUp,
  Plus,
  Circle,
  CheckCircle2,
  Send,
  User,
  Calendar,
  Clock,
} from 'lucide-react';
import { Summary, Transcript } from '@/types';

type Bucket = 'summary' | 'actions' | 'topics' | 'insights';

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

function inlineText(node: any): string {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(inlineText).join('');
  if (typeof node === 'object') {
    if (typeof node.text === 'string') return node.text;
    if (node.content) return inlineText(node.content);
  }
  return '';
}

function blocksToMarkdown(blocks: any[]): string {
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

function normalize(aiSummary: any): Record<Bucket, string[]> {
  if (!aiSummary) return { summary: [], actions: [], topics: [], insights: [] };
  if (typeof aiSummary === 'string') return parseMarkdownBuckets(aiSummary);
  if (typeof aiSummary.markdown === 'string') return parseMarkdownBuckets(aiSummary.markdown);
  if (Array.isArray(aiSummary.summary_json)) return parseMarkdownBuckets(blocksToMarkdown(aiSummary.summary_json));
  return bucketizeSections(aiSummary);
}

const OWNER_CHIP = [
  'bg-purple-500/15 text-purple-300',
  'bg-blue-500/15 text-blue-300',
  'bg-teal-500/15 text-teal-300',
  'bg-amber-500/15 text-amber-300',
  'bg-pink-500/15 text-pink-300',
  'bg-indigo-500/15 text-indigo-300',
];

function ownerChip(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return OWNER_CHIP[h % OWNER_CHIP.length];
}

const MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*';

interface ParsedAction {
  owner: string | null;
  due: string | null;
  timestamp: string | null;
  text: string;
}

function parseAction(raw: string): ParsedAction {
  let text = raw.replace(/^[\s\-*•]+/, '').trim();
  let owner: string | null = null;

  let m = text.match(/^@([A-Za-z][\w.'-]*)\s+(.*)$/);
  if (m) { owner = m[1]; text = m[2].trim(); }
  if (!owner) { m = text.match(/^\[([^\]]{1,40})\]\s*[:\-–—]?\s*(.*)$/); if (m) { owner = m[1].trim(); text = m[2].trim(); } }
  if (!owner) { m = text.match(/^([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})\s*[:\-–—]\s+(.+)$/); if (m) { owner = m[1].trim(); text = m[2].trim(); } }
  if (!owner) {
    m = text.match(/\b(?:owner|assigned to|assignee|owned by)\s*[:\-]?\s*([A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+)?)/i);
    if (m) { owner = m[1].trim(); text = text.replace(m[0], '').trim(); }
  }

  let date: string | null = null;
  let d = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (d) date = d[1];
  if (!date) { d = text.match(new RegExp(`\\b(${MONTHS}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?)\\b`, 'i')); if (d) date = d[1]; }
  if (!date) { d = text.match(/\b(tomorrow|next week|end of week|EOD|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/i); if (d) date = d[1]; }
  if (date && d) {
    text = text.replace(d[0], '').replace(/\b(by|due|on|before)\s*$/i, '').replace(/[\(\[]\s*[\)\]]?\s*$/, '').replace(/[,\-–—]\s*$/, '').trim();
  }

  return { owner, due: date, timestamp: null, text: text.replace(/\s{2,}/g, ' ').trim() };
}

// ---- Markdown-table action items -------------------------------------------
// Models often emit action items as a GFM table (| Owner | Task | Due | … |).
// Splitting that by line turns the header row and the `| --- |` separator into
// bogus "action items" and crams every column into one line. These helpers
// parse the table into structured items instead, dropping header/separator.

function splitTableRow(row: string): string[] {
  let s = row.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.every((c) => c === '' || /^:?-{2,}:?$/.test(c.replace(/\s/g, '')));
}

function stripCell(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/^["'“”\s]+|["'“”\s]+$/g, '')
    .trim();
}

function parseActionTable(rows: string[]): ParsedAction[] {
  const grid = rows.map(splitTableRow);
  let h = 0;
  while (h < grid.length && isSeparatorRow(grid[h])) h++;
  const header = (grid[h] ?? []).map((c) => stripCell(c).toLowerCase());
  const col = (re: RegExp) => header.findIndex((c) => re.test(c));
  const ownerIdx = col(/owner|assignee|assigned|who|responsible/);
  const taskIdx = col(/task|action|item|descr|to-?do|deliverable|next/);
  const dueIdx = col(/due|date|when|deadline|timeline/);
  const timeIdx = col(/time.?stamp|timestamp/);

  const items: ParsedAction[] = [];
  for (let i = h + 1; i < grid.length; i++) {
    const cells = grid[i];
    if (isSeparatorRow(cells) || cells.every((c) => c === '')) continue;
    const owner = ownerIdx >= 0 ? stripCell(cells[ownerIdx] ?? '') : '';
    const due = dueIdx >= 0 ? stripCell(cells[dueIdx] ?? '') : '';
    const time = timeIdx >= 0 ? stripCell(cells[timeIdx] ?? '') : '';
    let task = taskIdx >= 0 ? stripCell(cells[taskIdx] ?? '') : '';
    if (!task) {
      // No recognizable task column: fall back to the longest remaining cell.
      task =
        cells
          .map(stripCell)
          .filter((c, idx) => c && idx !== ownerIdx && idx !== dueIdx && idx !== timeIdx)
          .sort((a, b) => b.length - a.length)[0] ?? '';
    }
    if (!task) continue;
    items.push({
      owner: owner || null,
      due: due || null,
      timestamp: time ? time.replace(/^[[(]+|[\])]+$/g, '').trim() : null,
      text: task,
    });
  }
  return items;
}

/** Turn the raw action bucket (a markdown table and/or plain list) into
 *  structured items. Table header/separator rows are dropped, not shown. */
function parseActionItems(lines: string[]): ParsedAction[] {
  const table = lines.filter((l) => l.trim().startsWith('|'));
  const plain = lines.filter((l) => !l.trim().startsWith('|'));
  const items: ParsedAction[] = [];
  if (table.length >= 2) items.push(...parseActionTable(table));
  for (const line of plain) {
    const t = line.trim();
    if (!t) continue;
    const a = parseAction(t);
    if (a.text) items.push(a);
  }
  return items;
}

function topicLabel(raw: string): string {
  const t = raw.replace(/^[\s\-*•]+/, '').trim();
  const colon = t.indexOf(':');
  if (colon > 0 && colon <= 40) return t.slice(0, colon).trim();
  return t.length > 40 ? t.slice(0, 38).trim() + '…' : t;
}

const MAX_CONTEXT_CHARS = 6000;

interface QA {
  id: number;
  question: string;
  answer: string;
  status: 'pending' | 'done' | 'error';
}

interface InsightTabsProps {
  aiSummary: Summary | null;
  transcripts: Transcript[];
  generating?: boolean;
  onGenerate?: () => void;
  onCopySummary?: () => void | Promise<void>;
  onRegenerate?: () => void | Promise<void>;
}

export function InsightTabs({
  aiSummary,
  transcripts,
  generating = false,
  onGenerate,
  onCopySummary,
  onRegenerate,
}: InsightTabsProps) {
  const [done, setDone] = useState<Set<string>>(new Set());

  const buckets = useMemo(() => normalize(aiSummary), [aiSummary]);
  const actions = useMemo(() => parseActionItems(buckets.actions), [buckets.actions]);
  const summaryText = useMemo(() => buckets.summary.join('\n\n'), [buckets.summary]);
  const hasSummary = !!aiSummary;

  const toggleDone = (key: string) =>
    setDone((prev) => {
      const n = new Set(prev);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });

  // Ask-AI, grounded in this meeting's transcript.
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<QA[]>([]);
  const nextId = useRef(1);

  const transcriptContext = useMemo(() => {
    const joined = transcripts
      .map((t) => (t.speaker ? `${t.speaker}: ` : '') + (t.text ?? ''))
      .filter(Boolean)
      .join('\n');
    return joined.length > MAX_CONTEXT_CHARS ? joined.slice(-MAX_CONTEXT_CHARS) : joined;
  }, [transcripts]);

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    const id = nextId.current++;
    setQuestion('');
    setHistory((prev) => [...prev, { id, question: q, answer: '', status: 'pending' }]);
    setBusy(true);
    try {
      const answer = await invoke<string>('ask_live_assistant', { question: q, transcriptContext, persona: null });
      setHistory((prev) => prev.map((x) => (x.id === id ? { ...x, answer, status: 'done' } : x)));
    } catch (err) {
      const msg = typeof err === 'string' ? err : (err as any)?.message || 'Request failed';
      setHistory((prev) => prev.map((x) => (x.id === id ? { ...x, answer: `⚠️ ${msg}`, status: 'error' } : x)));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void ask();
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-[var(--af-bg)]">
      {/* Scrolling content */}
      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto px-6 py-6">
        {/* AI Summary */}
        <section>
          <div className="mb-3 flex items-center gap-2">
            <Sparkles size={18} className="text-cyan-400" />
            <h3 className="text-base font-semibold text-[var(--af-text)]">AI Summary</h3>
          </div>
          {generating ? (
            <div className="flex items-center gap-3 py-2 text-sm text-[var(--af-text-2)]">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--af-accent)] border-t-transparent" />
              Generating summary…
            </div>
          ) : !hasSummary ? (
            <div className="rounded-xl border border-dashed border-[var(--af-border-strong)] p-8 text-center">
              <Sparkles size={26} className="mx-auto mb-3 text-cyan-400" />
              <p className="mb-4 text-sm text-[var(--af-text-2)]">
                No summary yet. Generate an AI summary with key points, action items and topics.
              </p>
              <button
                onClick={() => onGenerate?.()}
                className="inline-flex items-center gap-2 rounded-lg bg-[var(--af-accent)] px-4 py-2 text-sm font-medium text-white transition-[filter] hover:brightness-110"
              >
                <Sparkles size={15} /> Generate summary
              </button>
            </div>
          ) : (
            <>
              {summaryText ? (
                <div className="prose prose-invert prose-sm max-w-none leading-relaxed text-[var(--af-text-2)] prose-strong:text-[var(--af-text)] prose-p:my-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{summaryText}</ReactMarkdown>
                </div>
              ) : (
                <p className="text-sm text-[var(--af-text-3)]">No summary text available.</p>
              )}
              <div className="mt-4 flex items-center gap-2">
                <ToolbarButton icon={<Copy size={14} />} onClick={() => { void onCopySummary?.(); toast.success('Summary copied'); }}>Copy</ToolbarButton>
                <ToolbarButton icon={<RefreshCw size={14} />} onClick={() => void onRegenerate?.()}>Regenerate</ToolbarButton>
                <ToolbarButton className="ml-auto" icon={<ThumbsUp size={14} />} onClick={() => toast.success('Thanks for the feedback')}>Good summary</ToolbarButton>
              </div>
            </>
          )}
        </section>

        {/* Action Items */}
        <section>
          <div className="mb-1 flex items-center gap-2">
            <Sparkles size={18} className="text-cyan-400" />
            <h3 className="text-base font-semibold text-[var(--af-text)]">Action Items</h3>
            {!generating && actions.length > 0 && <span className="text-sm font-medium text-[var(--af-text-3)]">{actions.length}</span>}
            <div className="ml-auto">
              <ToolbarButton icon={<Plus size={14} />} onClick={() => toast.info('Adding action items is coming soon')}>Add action item</ToolbarButton>
            </div>
          </div>
          {generating ? (
            <div className="flex items-center gap-3 py-2 text-sm text-[var(--af-text-2)]">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--af-accent)] border-t-transparent" />
              {hasSummary ? 'Regenerating action items…' : 'Generating action items…'}
            </div>
          ) : actions.length === 0 ? (
            <div className="py-6 text-center text-sm text-[var(--af-text-3)]">No action items were identified.</div>
          ) : (
            <div>
              {actions.map((a, i) => {
                const key = `a-${i}`;
                const isDone = done.has(key);
                return (
                  <div key={i} className="flex items-start gap-3 border-b border-[var(--af-border)] py-3 last:border-0">
                    <button
                      onClick={() => toggleDone(key)}
                      className="mt-0.5 shrink-0 text-[var(--af-text-3)] transition-colors hover:text-[var(--af-accent)]"
                      title={isDone ? 'Mark as not done' : 'Mark as done'}
                    >
                      {isDone ? <CheckCircle2 size={18} className="text-[var(--af-accent)]" /> : <Circle size={18} />}
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className={`text-sm leading-relaxed ${isDone ? 'text-[var(--af-text-3)] line-through' : 'text-[var(--af-text)]'}`}>
                        {a.text}
                      </p>
                      {(a.owner || a.due || a.timestamp) && (
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {a.owner && (
                            <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium ${ownerChip(a.owner)}`}>
                              <User size={11} />
                              {a.owner}
                            </span>
                          )}
                          {a.due && (
                            <span className="inline-flex items-center gap-1 rounded-md bg-[var(--af-panel-2)] px-2 py-0.5 text-xs text-[var(--af-text-2)]">
                              <Calendar size={11} />
                              {a.due}
                            </span>
                          )}
                          {a.timestamp && (
                            <span className="inline-flex items-center gap-1 rounded-md border border-[var(--af-border)] px-2 py-0.5 font-mono text-[11px] text-[var(--af-text-3)]">
                              <Clock size={11} />
                              {a.timestamp}
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Key Topics */}
        <section>
          <h3 className="mb-3 text-base font-semibold text-[var(--af-text)]">Key Topics</h3>
          {generating ? (
            <div className="flex items-center gap-3 py-2 text-sm text-[var(--af-text-2)]">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-[var(--af-accent)] border-t-transparent" />
              {hasSummary ? 'Regenerating topics…' : 'Generating topics…'}
            </div>
          ) : buckets.topics.length === 0 ? (
            <div className="py-2 text-sm text-[var(--af-text-3)]">No key topics were identified.</div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {buckets.topics.map((t, i) => (
                <span
                  key={i}
                  title={t}
                  className="rounded-lg border border-[var(--af-border-strong)] bg-[var(--af-panel-2)] px-3 py-1.5 text-sm text-[var(--af-text-2)]"
                >
                  {topicLabel(t)}
                </span>
              ))}
            </div>
          )}
        </section>
      </div>

      {/* Ask AI */}
      <div className="border-t border-[var(--af-border)] px-6 py-4">
        {history.length > 0 && (
          <div className="mb-3 max-h-56 space-y-3 overflow-y-auto">
            {history.map((qa) => (
              <div key={qa.id} className="space-y-1">
                <div className="ml-auto flex w-fit max-w-[85%] items-center gap-1 rounded-lg bg-[var(--af-accent)] px-3 py-1.5 text-sm text-white">
                  {qa.question}
                </div>
                <div className="w-fit max-w-[92%] rounded-lg bg-[var(--af-panel-2)] px-3 py-2 text-sm text-[var(--af-text)]">
                  {qa.status === 'pending' ? (
                    <span className="inline-flex items-center gap-1 text-[var(--af-text-3)]">
                      <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--af-text-3)]" /> Thinking…
                    </span>
                  ) : (
                    <div className="prose prose-invert prose-sm max-w-none prose-p:my-1 prose-ul:my-1">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{qa.answer}</ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-center gap-3 rounded-xl border border-[var(--af-border-strong)] bg-[var(--af-panel-2)] px-4 py-2 focus-within:border-[var(--af-accent)]/60">
          <Sparkles size={17} className="shrink-0 text-cyan-400" />
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder="Ask AI about this meeting…"
            className="af-bare flex-1 resize-none border-0 bg-transparent py-1 text-sm text-[var(--af-text)] placeholder:text-[var(--af-text-3)] focus:outline-none focus:ring-0"
          />
          <button
            onClick={ask}
            disabled={busy || !question.trim()}
            className="flex h-9 w-9 items-center justify-center rounded-lg bg-[var(--af-accent)] text-white transition-[filter] hover:brightness-110 disabled:opacity-40"
            title="Ask AI"
          >
            <Send size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolbarButton({
  icon,
  children,
  onClick,
  className = '',
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-lg border border-[var(--af-border-strong)] px-3 py-1.5 text-sm text-[var(--af-text-2)] transition-colors hover:bg-[var(--af-hover)] hover:text-[var(--af-text)] ${className}`}
    >
      {icon}
      {children}
    </button>
  );
}

export default InsightTabs;
