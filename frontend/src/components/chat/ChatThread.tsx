'use client';

/**
 * The one Ask-AI conversation used for meetings, people, and the live
 * recorder. Answers are Markdown; citations like [12:34] become buttons that
 * seek the recording. Conversations are kept per subject for the session, so
 * leaving a page and coming back keeps the thread.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowUp, RotateCcw, Sparkles, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Hint } from '@/components/ui/tooltip';

export interface ChatMessage {
  id: string;
  question: string;
  answer?: string;
  status: 'pending' | 'done' | 'error';
}

const threads = new Map<string, ChatMessage[]>();

function load(key: string): ChatMessage[] {
  if (threads.has(key)) return threads.get(key)!;
  try {
    const raw = sessionStorage.getItem(`af-chat:${key}`);
    if (raw) {
      const parsed = (JSON.parse(raw) as ChatMessage[]).filter((message) => message.status !== 'pending');
      threads.set(key, parsed);
      return parsed;
    }
  } catch {
    // Ignore unreadable history.
  }
  return [];
}

function store(key: string, messages: ChatMessage[]) {
  threads.set(key, messages);
  try {
    sessionStorage.setItem(`af-chat:${key}`, JSON.stringify(messages.slice(-30)));
  } catch {
    // History just won't survive a reload.
  }
}

/** Session-scoped history for one subject, e.g. `meeting:<id>`. */
export function useChatHistory(key: string) {
  const [messages, setMessages] = useState<ChatMessage[]>(() => (typeof window === 'undefined' ? [] : load(key)));
  useEffect(() => setMessages(load(key)), [key]);
  const update = useCallback(
    (updater: (current: ChatMessage[]) => ChatMessage[]) => {
      setMessages((current) => {
        const next = updater(current);
        store(key, next);
        return next;
      });
    },
    [key],
  );
  return [messages, update] as const;
}

const CITATION = /\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g;

function toSeconds(stamp: string): number {
  return stamp.split(':').map(Number).reduce((total, part) => total * 60 + part, 0);
}

export interface ChatThreadProps {
  historyKey: string;
  ask: (question: string, history: Array<{ question: string; answer: string }>) => Promise<string>;
  suggestions?: string[];
  placeholder?: string;
  emptyTitle?: string;
  emptyHint?: string;
  footnote?: string;
  onSeek?: (seconds: number) => void;
  className?: string;
  compact?: boolean;
}

export function ChatThread({
  historyKey,
  ask,
  suggestions = [],
  placeholder = 'Ask a question…',
  emptyTitle = 'Ask anything',
  emptyHint,
  footnote,
  onSeek,
  className,
  compact = false,
}: ChatThreadProps) {
  const [messages, update] = useChatHistory(historyKey);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const busy = messages.some((message) => message.status === 'pending');

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const send = async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const history = messages.filter((m) => m.status === 'done' && m.answer).map((m) => ({ question: m.question, answer: m.answer! }));
    update((current) => [...current, { id, question: text, status: 'pending' }]);
    setDraft('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    try {
      const answer = await ask(text, history);
      update((current) => current.map((m) => (m.id === id ? { ...m, answer, status: 'done' } : m)));
    } catch (error) {
      const message = typeof error === 'string' ? error : error instanceof Error ? error.message : 'Request failed';
      update((current) => current.map((m) => (m.id === id ? { ...m, answer: message, status: 'error' } : m)));
    }
  };

  const retry = (message: ChatMessage) => {
    update((current) => current.filter((m) => m.id !== message.id));
    void send(message.question);
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div ref={scrollRef} className={cn('min-h-0 flex-1 overflow-y-auto', compact ? 'px-3 py-3' : 'px-5 py-4')}>
        {messages.length === 0 ? (
          <div className="flex h-full min-h-[12rem] flex-col items-center justify-center text-center">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-af-accent/[0.12] text-af-accent">
              <Sparkles className="h-4 w-4" />
            </span>
            <p className="text-sm font-medium text-af-text">{emptyTitle}</p>
            {emptyHint && <p className="mt-1 max-w-xs text-xs leading-relaxed text-af-text-3">{emptyHint}</p>}
            {suggestions.length > 0 && (
              <div className="mt-4 flex max-w-sm flex-wrap justify-center gap-1.5">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => void send(suggestion)}
                    className="rounded-full border border-af-border bg-af-panel-2 px-3 py-1.5 text-xs text-af-text-2 transition-colors hover:border-af-accent/40 hover:text-af-text"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((message) => (
              <div key={message.id} className="space-y-2 animate-af-rise">
                <div className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-af-accent px-3.5 py-2 text-[13px] leading-relaxed text-af-on-accent">
                  {message.question}
                </div>
                <div
                  className={cn(
                    'w-fit max-w-[96%] rounded-2xl rounded-bl-md border px-3.5 py-2.5 text-[13px]',
                    message.status === 'error' ? 'border-af-danger/30 bg-af-danger/[0.06]' : 'border-af-border bg-af-panel-2',
                  )}
                >
                  {message.status === 'pending' ? (
                    <span className="flex items-center gap-2 text-af-text-3">
                      <span className="flex gap-1">
                        {[0, 1, 2].map((dot) => (
                          <span key={dot} className="h-1.5 w-1.5 animate-af-breathe rounded-full bg-af-text-3" style={{ animationDelay: `${dot * 180}ms` }} />
                        ))}
                      </span>
                      Reading the records…
                    </span>
                  ) : message.status === 'error' ? (
                    <div className="space-y-2">
                      <p className="text-af-danger">Couldn’t answer: {message.answer}</p>
                      <button type="button" onClick={() => retry(message)} className="inline-flex items-center gap-1.5 text-xs text-af-text-2 hover:text-af-text">
                        <RotateCcw className="h-3 w-3" /> Try again
                      </button>
                    </div>
                  ) : (
                    <div className="prose prose-sm max-w-none leading-relaxed prose-p:my-1.5 prose-ul:my-1.5 prose-li:my-0.5">
                      <ReactMarkdown
                        remarkPlugins={[remarkGfm]}
                        components={{
                          a: ({ href, children }) =>
                            href?.startsWith('#t=') && onSeek ? (
                              <button
                                type="button"
                                onClick={() => onSeek(toSeconds(href.slice(3)))}
                                className="mx-0.5 inline-flex items-center rounded bg-af-accent/[0.12] px-1 py-px align-baseline text-[11px] font-medium tabular-nums text-af-accent no-underline hover:bg-af-accent/20"
                              >
                                {children}
                              </button>
                            ) : (
                              <a href={href} target="_blank" rel="noreferrer">
                                {children}
                              </a>
                            ),
                        }}
                      >
                        {(message.answer ?? '').replace(CITATION, onSeek ? '[$1](#t=$1)' : '[$1]')}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className={cn('shrink-0 border-t border-af-border', compact ? 'p-2.5' : 'p-3')}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
          className="flex items-end gap-2 rounded-xl border border-af-border-strong bg-af-panel-2 p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-af-accent focus-within:shadow-[0_0_0_3px_rgb(var(--af-accent-rgb)/0.14)]"
        >
          <textarea
            ref={inputRef}
            value={draft}
            rows={1}
            onChange={(event) => {
              setDraft(event.target.value);
              event.target.style.height = 'auto';
              event.target.style.height = `${Math.min(event.target.scrollHeight, 120)}px`;
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
            placeholder={placeholder}
            className="af-bare max-h-[120px] min-h-[32px] flex-1 resize-none bg-transparent py-1.5 text-[13px] leading-relaxed text-af-text outline-none placeholder:text-af-text-4"
          />
          {messages.length > 0 && (
            <Hint label="Clear conversation">
              <button
                type="button"
                onClick={() => update(() => [])}
                disabled={busy}
                aria-label="Clear conversation"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-af-text-4 transition-colors hover:bg-af-hover hover:text-af-text-2 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </Hint>
          )}
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            aria-label="Send"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-af-accent text-af-on-accent transition-[background-color,opacity,transform] hover:bg-af-accent-hover active:scale-95 disabled:opacity-35"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </form>
        {footnote && <p className="mt-1.5 px-1 text-[10px] leading-relaxed text-af-text-4">{footnote}</p>}
      </div>
    </div>
  );
}
