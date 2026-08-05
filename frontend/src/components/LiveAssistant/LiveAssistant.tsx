'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranscripts } from '@/contexts/TranscriptContext';
import { retrieveContext } from '@/lib/rag';

/**
 * Live AI Assistant
 *
 * Answers questions during a meeting, grounded in the recent live transcript, routed
 * through whatever model you've configured (local Ollama, bundled local model, or any
 * BYOK provider such as Gemini / OpenAI / Claude / Groq).
 *
 * Extras: persona presets, a custom-context notes box that's injected into every prompt,
 * a per-answer "say it naturally" humanizer, auto-suggest on detected questions, and
 * dynamic follow-up chips.
 *
 * Operates on the transcript the app is already capturing for your own notes — a
 * consented meeting assistant, not a hidden overlay.
 */

const MAX_CONTEXT_CHARS = 6000;
const AUTO_SUGGEST_COOLDOWN_MS = 6000;
const MIN_QUESTION_LEN = 12;

const QUESTION_STARTERS = [
  'what', 'why', 'how', 'when', 'where', 'who', 'which', 'whose', 'whom',
  'can', 'could', 'would', 'should', 'will', 'do', 'does', 'did', 'is', 'are',
  'was', 'were', 'have', 'has', 'may', 'might', 'shall', 'tell me', 'explain',
];

const PERSONAS: Record<string, { label: string; prompt: string }> = {
  general: { label: 'General', prompt: '' },
  sales: {
    label: 'Sales call',
    prompt: 'Act as a sales assistant. Focus on the prospect\'s needs, objections, buying signals, and suggested responses that move the deal forward.',
  },
  oneonone: {
    label: '1:1 / coaching',
    prompt: 'Act as a 1:1 coaching assistant. Focus on feedback, blockers, growth, and concrete action items.',
  },
  standup: {
    label: 'Standup',
    prompt: 'Act as a standup facilitator. Focus on progress, plans, and blockers. Keep answers terse.',
  },
  lecture: {
    label: 'Lecture / study',
    prompt: 'Act as a study assistant. Explain concepts clearly and simply, define jargon, and surface key takeaways.',
  },
  interview: {
    label: 'Interview prep',
    prompt: 'Act as an interview-preparation assistant for the user practicing on their own. Give concise, structured answers and talking points.',
  },
  technical: {
    label: 'Technical',
    prompt: 'Act as a technical assistant. Be precise, include code or commands when relevant, and call out trade-offs.',
  },
};

const QUICK_ASKS = [
  'Summarize the last 5 minutes',
  'What action items came up?',
  'What was decided?',
];

function looksLikeQuestion(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_QUESTION_LEN) return false;
  if (t.endsWith('?')) return true;
  const lower = t.toLowerCase();
  return QUESTION_STARTERS.some((w) => lower.startsWith(w + ' '));
}

interface QA {
  id: number;
  question: string;
  answer: string;
  status: 'pending' | 'done' | 'error';
  auto: boolean;
  followups?: string[];
  humanized?: string;
}

export function LiveAssistant() {
  const { transcripts } = useTranscripts();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [busy, setBusy] = useState(false);
  const [autoSuggest, setAutoSuggest] = useState(false);
  const [persona, setPersona] = useState('general');
  const [notes, setNotes] = useState('');
  const [showNotes, setShowNotes] = useState(false);
  const [ragOn, setRagOn] = useState(false);
  const [showRag, setShowRag] = useState(false);
  const [meetings, setMeetings] = useState<Array<{ id: string; title: string }>>([]);
  const [selectedMeetings, setSelectedMeetings] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<QA[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);

  const processedIds = useRef<Set<string>>(new Set());
  const lastAutoAt = useRef(0);
  const inFlight = useRef(false);

  const buildContext = useCallback((): string => {
    const joined = transcripts.map((t: any) => t?.text ?? '').filter(Boolean).join('\n');
    return joined.length > MAX_CONTEXT_CHARS ? joined.slice(-MAX_CONTEXT_CHARS) : joined;
  }, [transcripts]);

  // Combine persona preset + user notes into the system-prompt guidance
  const buildPersona = useCallback(
    (extra = ''): string | null => {
      const parts = [PERSONAS[persona]?.prompt || '', extra].filter(Boolean);
      if (notes.trim()) parts.push(`User-provided context/notes:\n${notes.trim()}`);
      const joined = parts.join('\n\n').trim();
      return joined || null;
    },
    [persona, notes],
  );

  const callModel = useCallback(
    async (q: string, context: string, personaText: string | null): Promise<string> => {
      return invoke<string>('ask_live_assistant', {
        question: q,
        transcriptContext: context,
        persona: personaText,
      });
    },
    [],
  );

  // Best-effort follow-up suggestions for the latest answer
  const fetchFollowups = useCallback(
    async (qaId: number, q: string, answer: string) => {
      try {
        const raw = await callModel(
          `Given the meeting and this Q/A, suggest exactly 3 short follow-up questions the user might ask next. ` +
            `One per line, no numbering, no extra text.\n\nQ: ${q}\nA: ${answer}`,
          buildContext(),
          null,
        );
        const chips = raw
          .split('\n')
          .map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim())
          .filter((l) => l.length > 3 && l.length < 120)
          .slice(0, 3);
        if (chips.length) {
          setHistory((prev) => prev.map((x) => (x.id === qaId ? { ...x, followups: chips } : x)));
        }
      } catch {
        /* follow-ups are best-effort */
      }
    },
    [callModel, buildContext],
  );

  const runQuery = useCallback(
    async (q: string, auto: boolean) => {
      const id = nextId.current++;
      setHistory((prev) => [...prev, { id, question: q, answer: '', status: 'pending', auto }]);
      inFlight.current = true;
      setBusy(true);

      const extra = auto
        ? 'A participant just asked the question below during the meeting. Draft a concise, accurate answer the user could give, in 1–4 sentences or a short list. Be direct.'
        : '';

      try {
        let ctx = buildContext();
        if (ragOn && selectedMeetings.size > 0) {
          try {
            const selected = meetings.filter((m) => selectedMeetings.has(m.id));
            const { context: ragCtx } = await retrieveContext(selected, q, {});
            if (ragCtx) ctx = `${ragCtx}\n\n---\n\nLive meeting transcript:\n${ctx}`;
          } catch {
            /* RAG is best-effort; fall back to live transcript only */
          }
        }
        const answer = await callModel(q, ctx, buildPersona(extra));
        setHistory((prev) => prev.map((qa) => (qa.id === id ? { ...qa, answer, status: 'done' } : qa)));
        void fetchFollowups(id, q, answer);
      } catch (err) {
        const msg = typeof err === 'string' ? err : (err as any)?.message || 'Request failed';
        setHistory((prev) =>
          prev.map((qa) => (qa.id === id ? { ...qa, answer: `⚠️ ${msg}`, status: 'error' } : qa)),
        );
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [callModel, buildContext, buildPersona, fetchFollowups, ragOn, selectedMeetings, meetings],
  );

  // Load past meetings when the RAG picker is first opened
  useEffect(() => {
    if (showRag && meetings.length === 0) {
      invoke<any[]>('api_get_meetings')
        .then((ms) => setMeetings((ms || []).map((m) => ({ id: m.id, title: m.title || 'Untitled meeting' }))))
        .catch(() => {});
    }
  }, [showRag, meetings.length]);

  const askText = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q || inFlight.current) return;
      void runQuery(q, false);
    },
    [runQuery],
  );

  const ask = useCallback(() => {
    const q = question.trim();
    if (!q || inFlight.current) return;
    setQuestion('');
    void runQuery(q, false);
  }, [question, runQuery]);

  // "Say it naturally" — rewrite an answer to sound conversational when spoken aloud
  const humanize = useCallback(
    async (qa: QA) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setBusy(true);
      try {
        const spoken = await callModel(
          `Rewrite the following so it sounds natural to say out loud in a meeting: first person, ` +
            `concise, conversational, no markdown headings or bullet symbols.\n\n${qa.answer}`,
          '',
          'You rewrite text to be spoken naturally and conversationally.',
        );
        setHistory((prev) => prev.map((x) => (x.id === qa.id ? { ...x, humanized: spoken } : x)));
      } catch {
        /* ignore */
      } finally {
        inFlight.current = false;
        setBusy(false);
      }
    },
    [callModel],
  );

  // Auto-suggest on detected questions in finalized transcript segments
  useEffect(() => {
    if (!autoSuggest || inFlight.current) return;
    const fresh = transcripts.filter(
      (t: any) => t?.id && !t?.is_partial && !processedIds.current.has(t.id),
    );
    if (fresh.length === 0) return;
    for (const t of fresh) processedIds.current.add((t as any).id);

    const now = Date.now();
    if (now - lastAutoAt.current < AUTO_SUGGEST_COOLDOWN_MS) return;

    const q = [...fresh].reverse().find((t: any) => looksLikeQuestion(t.text));
    if (!q) return;
    lastAutoAt.current = now;
    if (!open) setOpen(true);
    void runQuery((q as any).text.trim(), true);
  }, [transcripts, autoSuggest, open, runQuery]);

  useEffect(() => {
    if (open && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history, open]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      ask();
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        title="Ask the live AI assistant (grounded in this meeting's transcript)"
        className="fixed bottom-5 right-5 z-40 flex items-center gap-2 rounded-full bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-lg hover:bg-blue-700"
      >
        <span aria-hidden>✨</span>
        <span>Ask AI</span>
        {autoSuggest && <span className="h-2 w-2 rounded-full bg-green-400" title="Auto-suggest on" />}
      </button>
    );
  }

  return (
    <div className="fixed bottom-5 right-5 z-40 flex h-[560px] w-[400px] flex-col rounded-xl border border-gray-200 bg-white shadow-2xl">
      <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2">
        <div className="flex items-center gap-2">
          <span aria-hidden>✨</span>
          <span className="text-sm font-semibold text-gray-800">Live AI Assistant</span>
        </div>
        <div className="flex items-center gap-1">
          <select
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            className="rounded border border-gray-200 px-1 py-0.5 text-xs text-gray-600"
            title="Persona / mode"
          >
            {Object.entries(PERSONAS).map(([k, v]) => (
              <option key={k} value={k}>{v.label}</option>
            ))}
          </select>
          <button
            onClick={() => setShowNotes((s) => !s)}
            className={`rounded px-2 py-1 text-xs hover:bg-gray-100 ${notes.trim() ? 'text-blue-600' : 'text-gray-500'}`}
            title="Custom context / notes injected into every prompt"
          >
            Notes
          </button>
          <button
            onClick={() => setShowRag((s) => !s)}
            className={`rounded px-2 py-1 text-xs hover:bg-gray-100 ${ragOn ? 'text-blue-600' : 'text-gray-500'}`}
            title="Search past meetings (RAG)"
          >
            Past
          </button>
          <label className="flex cursor-pointer items-center gap-1 rounded px-2 py-1 text-xs text-gray-600 hover:bg-gray-100" title="Auto-suggest an answer when a question is heard">
            <input type="checkbox" checked={autoSuggest} onChange={(e) => setAutoSuggest(e.target.checked)} className="h-3 w-3" />
            Auto
          </label>
          <button onClick={() => setOpen(false)} className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100" title="Minimize">✕</button>
        </div>
      </div>

      {showNotes && (
        <div className="border-b border-gray-100 bg-gray-50 p-2">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            placeholder="Context the AI should always know: agenda, participant names, jargon, your goals…"
            className="w-full resize-none rounded border border-gray-200 px-2 py-1 text-xs focus:border-blue-400 focus:outline-none"
          />
        </div>
      )}

      {showRag && (
        <div className="border-b border-gray-100 bg-gray-50 p-2 text-xs">
          <label className="mb-1 flex items-center gap-2">
            <input type="checkbox" checked={ragOn} onChange={(e) => setRagOn(e.target.checked)} />
            <span className="font-medium text-gray-700">Search past meetings (RAG)</span>
          </label>
          <div className="max-h-28 overflow-y-auto rounded border border-gray-200 bg-white">
            {meetings.length === 0 ? (
              <div className="p-2 text-gray-400">No past meetings found.</div>
            ) : (
              meetings.map((m) => (
                <label key={m.id} className="flex cursor-pointer items-center gap-2 px-2 py-1 hover:bg-gray-50">
                  <input
                    type="checkbox"
                    checked={selectedMeetings.has(m.id)}
                    onChange={(e) =>
                      setSelectedMeetings((prev) => {
                        const n = new Set(prev);
                        if (e.target.checked) n.add(m.id);
                        else n.delete(m.id);
                        return n;
                      })
                    }
                  />
                  <span className="truncate">{m.title}</span>
                </label>
              ))
            )}
          </div>
          <div className="mt-1 text-gray-400">
            Requires Ollama + an embedding model (<code>ollama pull nomic-embed-text</code>).
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-1 border-b border-gray-100 px-2 py-1.5">
        {QUICK_ASKS.map((q) => (
          <button
            key={q}
            onClick={() => askText(q)}
            disabled={busy}
            className="rounded-full border border-gray-200 px-2 py-0.5 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50"
          >
            {q}
          </button>
        ))}
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto px-3 py-3">
        {history.length === 0 && (
          <div className="mt-6 text-center text-xs text-gray-400">
            Ask anything about the live conversation, or use a chip above.
            <br /><br />
            Pick a <strong>persona</strong>, add <strong>Notes</strong>, or turn on <strong>Auto</strong> to draft answers as questions come up.
          </div>
        )}
        {history.map((qa) => (
          <div key={qa.id} className="space-y-1">
            <div className="ml-auto flex w-fit max-w-[85%] items-center gap-1 rounded-lg bg-blue-600 px-3 py-1.5 text-sm text-white">
              {qa.auto && <span className="rounded bg-blue-800 px-1 text-[10px] uppercase tracking-wide">auto</span>}
              <span>{qa.question}</span>
            </div>
            <div className="w-fit max-w-[92%] rounded-lg bg-gray-100 px-3 py-2 text-sm text-gray-800">
              {qa.status === 'pending' ? (
                <span className="inline-flex items-center gap-1 text-gray-500">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-gray-400" /> Thinking…
                </span>
              ) : (
                <>
                  <div className="prose prose-sm max-w-none prose-p:my-1 prose-ul:my-1">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{qa.answer}</ReactMarkdown>
                  </div>
                  {qa.humanized && (
                    <div className="mt-2 rounded-md border border-green-200 bg-green-50 px-2 py-1 text-sm text-green-900">
                      <div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-green-600">Say it naturally</div>
                      {qa.humanized}
                    </div>
                  )}
                  {qa.status === 'done' && !qa.humanized && (
                    <button
                      onClick={() => humanize(qa)}
                      disabled={busy}
                      className="mt-1 text-xs text-blue-600 hover:underline disabled:opacity-50"
                      title="Rewrite this to sound natural spoken aloud"
                    >
                      🗣️ Say it naturally
                    </button>
                  )}
                  {qa.followups && qa.followups.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {qa.followups.map((f, i) => (
                        <button
                          key={i}
                          onClick={() => askText(f)}
                          disabled={busy}
                          className="rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-xs text-blue-700 hover:bg-blue-100 disabled:opacity-50"
                        >
                          {f}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="border-t border-gray-100 p-2">
        <div className="flex items-end gap-2">
          <textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder="Ask about the meeting…  (Enter to send)"
            className="flex-1 resize-none rounded-lg border border-gray-200 px-2 py-1.5 text-sm focus:border-blue-400 focus:outline-none"
          />
          <button onClick={ask} disabled={busy || !question.trim()} className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white disabled:bg-gray-300">
            {busy ? '…' : 'Ask'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default LiveAssistant;
