'use client';

/**
 * Static-export-compatible person profile route. People are runtime SQLite
 * records, so the ID lives in `/person?id=...` rather than a dynamic segment
 * that Next would need to enumerate during the build. Profile facts come from
 * explicit person/speaker mappings; the AI corpus is assembled in Rust.
 */

import { FormEvent, Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowLeft,
  ArrowUpRight,
  Bot,
  CalendarDays,
  Clock3,
  FileText,
  Loader2,
  LockKeyhole,
  MessageSquareText,
  RefreshCw,
  Save,
  Search,
  Send,
  Sparkles,
  UserRound,
} from 'lucide-react';
import type { PersonProfile } from '@/types';

const PROFILE_OVERVIEW_QUESTION = 'Create a concise profile overview of this person based only on their meeting records. Cover recurring topics, decisions, commitments, collaboration patterns, and recent changes. Cite the relevant meeting title and date for every substantive point, and clearly distinguish recorded facts from inference.';

type AIMessage = {
  id: number;
  question: string;
  answer: string;
  status: 'pending' | 'complete' | 'error';
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return parts.slice(0, 2).map((part) => part.charAt(0).toUpperCase()).join('');
}

function formatDate(value?: string, includeYear = true): string {
  if (!value) return 'Not available';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: includeYear ? 'numeric' : undefined,
  });
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0 min';
  const roundedMinutes = Math.max(1, Math.round(seconds / 60));
  const hours = Math.floor(roundedMinutes / 60);
  const minutes = roundedMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes > 0 ? `${hours} hr ${minutes} min` : `${hours} hr`;
}

function ProfileLoading() {
  return (
    <div className="h-full overflow-y-auto bg-[var(--af-bg)] px-5 py-8 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-6xl animate-pulse">
        <div className="h-8 w-28 rounded-lg bg-[var(--af-panel-2)]" />
        <div className="mt-10 flex items-center gap-5">
          <div className="h-24 w-24 rounded-full bg-[var(--af-panel-2)]" />
          <div className="space-y-3">
            <div className="h-8 w-52 rounded bg-[var(--af-panel-2)]" />
            <div className="h-4 w-72 rounded bg-[var(--af-panel-2)]" />
          </div>
        </div>
        <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[0, 1, 2, 3].map((item) => <div key={item} className="h-28 rounded-2xl bg-[var(--af-panel)]" />)}
        </div>
        <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.65fr)]">
          <div className="h-96 rounded-2xl bg-[var(--af-panel)]" />
          <div className="h-72 rounded-2xl bg-[var(--af-panel)]" />
        </div>
      </div>
    </div>
  );
}

function ProfileProblem({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto bg-[var(--af-bg)] p-6">
      <div className="w-full max-w-md rounded-2xl border border-[var(--af-border)] bg-[var(--af-panel)] p-8 text-center shadow-lg">
        <span className="mx-auto flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--af-panel-2)] text-[var(--af-text-2)]">
          <UserRound className="h-5 w-5" />
        </span>
        <h1 className="mt-4 text-lg font-semibold text-[var(--af-text)]">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--af-text-2)]">{detail}</p>
        <div className="mt-6 flex justify-center gap-3">
          {retry && (
            <button onClick={retry} className="inline-flex items-center gap-2 rounded-lg bg-[var(--af-accent)] px-4 py-2 text-sm font-medium text-white hover:brightness-110">
              <RefreshCw className="h-4 w-4" /> Retry
            </button>
          )}
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-global-search'))}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--af-border-strong)] px-4 py-2 text-sm font-medium text-[var(--af-text-2)] hover:bg-[var(--af-hover)] hover:text-[var(--af-text)]"
          >
            <Search className="h-4 w-4" /> Search people
          </button>
        </div>
      </div>
    </div>
  );
}

function PersonProfileContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const personId = searchParams.get('id');
  const [profile, setProfile] = useState<PersonProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [notes, setNotes] = useState('');
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesError, setNotesError] = useState<string | null>(null);
  const [notesSaved, setNotesSaved] = useState(false);
  const [overview, setOverview] = useState<string | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [question, setQuestion] = useState('');
  const [history, setHistory] = useState<AIMessage[]>([]);
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    setProfile(null);
    setLoadError(null);
    setOverview(null);
    setOverviewError(null);
    setHistory([]);
    setQuestion('');

    if (!personId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    invoke<PersonProfile>('api_get_person_profile', { personId })
      .then((nextProfile) => {
        if (cancelled) return;
        setProfile(nextProfile);
        setNotes(nextProfile.notes ?? '');
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('Failed to load person profile:', error);
        setLoadError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [personId, reloadKey]);

  const saveNotes = async () => {
    if (!personId || !profile || savingNotes) return;
    setSavingNotes(true);
    setNotesError(null);
    setNotesSaved(false);
    try {
      await invoke('api_update_person_notes', { personId, notes });
      setProfile((current) => current ? { ...current, notes } : current);
      setNotesSaved(true);
      window.setTimeout(() => setNotesSaved(false), 1800);
    } catch (error) {
      console.error('Failed to save person notes:', error);
      setNotesError(error instanceof Error ? error.message : String(error));
    } finally {
      setSavingNotes(false);
    }
  };

  const generateOverview = async () => {
    if (!personId || overviewLoading) return;
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      const answer = await invoke<string>('ask_person', {
        personId,
        question: PROFILE_OVERVIEW_QUESTION,
      });
      setOverview(answer);
    } catch (error) {
      console.error('Failed to generate person overview:', error);
      setOverviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setOverviewLoading(false);
    }
  };

  const askQuestion = async (event?: FormEvent) => {
    event?.preventDefault();
    const trimmed = question.trim();
    if (!personId || !trimmed || asking) return;

    const id = Date.now();
    setHistory((current) => [...current, { id, question: trimmed, answer: '', status: 'pending' }]);
    setQuestion('');
    setAsking(true);
    try {
      const answer = await invoke<string>('ask_person', { personId, question: trimmed });
      setHistory((current) => current.map((message) => (
        message.id === id ? { ...message, answer, status: 'complete' } : message
      )));
    } catch (error) {
      console.error('Failed to ask about person:', error);
      const message = error instanceof Error ? error.message : String(error);
      setHistory((current) => current.map((item) => (
        item.id === id ? { ...item, answer: message, status: 'error' } : item
      )));
    } finally {
      setAsking(false);
    }
  };

  if (loading) return <ProfileLoading />;
  if (!personId) {
    return <ProfileProblem title="No person selected" detail="Open global search and choose a person to view their meeting profile." />;
  }
  if (loadError || !profile) {
    return (
      <ProfileProblem
        title="Couldn't load this profile"
        detail={loadError ?? 'This person may no longer exist in your meeting library.'}
        retry={() => setReloadKey((key) => key + 1)}
      />
    );
  }

  const notesDirty = notes !== (profile.notes ?? '');
  const seenRange = [profile.firstSeenAt, profile.lastSeenAt]
    .filter((value): value is string => Boolean(value))
    .map((value) => formatDate(value))
    .join(' - ') || 'No dated meetings';

  return (
    <div className="h-full overflow-y-auto bg-[var(--af-bg)] pr-4 sm:pr-6 lg:pr-8">
      <div className="mx-auto max-w-6xl px-1 py-6 sm:py-8">
        <button
          onClick={() => router.back()}
          className="inline-flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm text-[var(--af-text-2)] hover:bg-[var(--af-hover)] hover:text-[var(--af-text)]"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </button>

        <header className="relative mt-5 overflow-hidden rounded-3xl border border-[var(--af-border)] bg-[var(--af-panel)] px-6 py-7 shadow-lg sm:px-8 sm:py-9">
          <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-[radial-gradient(circle,rgba(74,139,255,0.18),transparent_68%)]" />
          <div className="pointer-events-none absolute bottom-[-90px] left-[38%] h-48 w-72 rounded-full bg-[radial-gradient(circle,rgba(115,87,216,0.11),transparent_70%)]" />
          <div className="relative flex flex-col gap-5 sm:flex-row sm:items-center">
            <div className="flex h-24 w-24 shrink-0 items-center justify-center rounded-full border-4 border-[var(--af-panel-2)] bg-gradient-to-br from-[#5b8cff] via-[#5877e8] to-[#7357d8] text-3xl font-semibold tracking-tight text-white shadow-xl">
              {initials(profile.displayName)}
            </div>
            <div className="min-w-0">
              <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--af-accent)]">
                <span className="h-px w-6 bg-[var(--af-accent)]" /> Person profile
              </div>
              <h1 className="truncate text-3xl font-semibold text-[var(--af-text)] sm:text-4xl">{profile.displayName}</h1>
              <p className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-[var(--af-text-2)]">
                <span>{profile.meetingCount} shared meeting{profile.meetingCount === 1 ? '' : 's'}</span>
                <span className="text-[var(--af-text-3)]">/</span>
                <span>{seenRange}</span>
              </p>
            </div>
          </div>
        </header>

        <section className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: CalendarDays, label: 'Shared meetings', value: profile.meetingCount.toLocaleString() },
            { icon: MessageSquareText, label: 'Messages', value: profile.messageCount.toLocaleString() },
            { icon: Clock3, label: 'Speaking time', value: formatDuration(profile.totalSpeakingSeconds) },
            { icon: UserRound, label: 'Last seen', value: formatDate(profile.lastSeenAt, false) },
          ].map((stat) => (
            <div key={stat.label} className="rounded-2xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4 shadow-sm">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[var(--af-accent-soft)] text-[var(--af-accent)]">
                <stat.icon className="h-4 w-4" />
              </span>
              <div className="mt-4 text-xl font-semibold tabular-nums text-[var(--af-text)]">{stat.value}</div>
              <div className="mt-0.5 text-xs text-[var(--af-text-3)]">{stat.label}</div>
            </div>
          ))}
        </section>

        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[minmax(0,1.35fr)_minmax(310px,0.65fr)]">
          <div className="min-w-0 space-y-6">
            <section className="overflow-hidden rounded-2xl border border-[var(--af-border)] bg-[var(--af-panel)] shadow-sm">
              <div className="flex items-start justify-between gap-4 border-b border-[var(--af-border)] px-5 py-4 sm:px-6">
                <div>
                  <div className="flex items-center gap-2">
                    <Sparkles className="h-4 w-4 text-cyan-400" />
                    <h2 className="font-semibold text-[var(--af-text)]">AI profile overview</h2>
                  </div>
                  <p className="mt-1 text-xs text-[var(--af-text-3)]">Patterns grounded in this person's recorded meetings, with citations.</p>
                </div>
                {(overview || overviewError) && !overviewLoading && (
                  <button onClick={generateOverview} className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-[var(--af-border-strong)] px-3 py-1.5 text-xs font-medium text-[var(--af-text-2)] hover:bg-[var(--af-hover)] hover:text-[var(--af-text)]">
                    <RefreshCw className="h-3.5 w-3.5" /> Regenerate
                  </button>
                )}
              </div>
              <div className="p-5 sm:p-6">
                {overviewLoading ? (
                  <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-sm text-[var(--af-text-2)]">
                    <Loader2 className="h-5 w-5 animate-spin text-cyan-400" />
                    Reviewing meeting records and citations...
                  </div>
                ) : overview ? (
                  <>
                    <div className="prose prose-invert prose-sm max-w-none leading-relaxed text-[var(--af-text-2)] prose-headings:text-[var(--af-text)] prose-strong:text-[var(--af-text)] prose-p:my-2 prose-ul:my-2">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{overview}</ReactMarkdown>
                    </div>
                    {overviewError && <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-400">Regeneration failed: {overviewError}</p>}
                  </>
                ) : (
                  <div className="rounded-xl border border-dashed border-[var(--af-border-strong)] px-5 py-8 text-center">
                    <Bot className="mx-auto h-7 w-7 text-cyan-400" />
                    <p className="mt-3 text-sm font-medium text-[var(--af-text)]">Build a useful profile from their meeting history</p>
                    <p className="mx-auto mt-1 max-w-md text-xs leading-relaxed text-[var(--af-text-3)]">
                      Summarize recurring topics, commitments, collaboration patterns, and recent changes with meeting citations.
                    </p>
                    {overviewError && <p className="mx-auto mt-3 max-w-md text-xs text-red-400">{overviewError}</p>}
                    <button onClick={generateOverview} className="mt-5 inline-flex items-center gap-2 rounded-lg bg-[var(--af-accent)] px-4 py-2 text-sm font-medium text-white hover:brightness-110">
                      <Sparkles className="h-4 w-4" /> Generate overview
                    </button>
                  </div>
                )}
              </div>
            </section>

            <section>
              <div className="mb-3 flex items-end justify-between gap-3 px-1">
                <div>
                  <h2 className="text-lg font-semibold text-[var(--af-text)]">Meeting history</h2>
                  <p className="mt-0.5 text-xs text-[var(--af-text-3)]">Every meeting where this person has attributed messages.</p>
                </div>
                <span className="text-xs tabular-nums text-[var(--af-text-3)]">{profile.meetings.length} record{profile.meetings.length === 1 ? '' : 's'}</span>
              </div>

              {profile.meetings.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-[var(--af-border-strong)] bg-[var(--af-panel)] px-6 py-12 text-center">
                  <FileText className="mx-auto h-7 w-7 text-[var(--af-text-3)]" />
                  <p className="mt-3 text-sm font-medium text-[var(--af-text)]">No attributed meeting records</p>
                  <p className="mt-1 text-xs text-[var(--af-text-3)]">Meetings will appear here when messages are linked to this person.</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {profile.meetings.map((meeting) => (
                    <button
                      key={meeting.meetingId}
                      onClick={() => router.push(`/meeting-details?id=${encodeURIComponent(meeting.meetingId)}`)}
                      className="group w-full rounded-2xl border border-[var(--af-border)] bg-[var(--af-panel)] p-5 text-left shadow-sm hover:border-[var(--af-border-strong)] hover:bg-[var(--af-hover)]"
                    >
                      <div className="flex items-start gap-4">
                        <span className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[var(--af-panel-2)] text-[var(--af-text-2)] group-hover:bg-[var(--af-accent-soft)] group-hover:text-[var(--af-accent)]">
                          <CalendarDays className="h-4 w-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-start justify-between gap-3">
                            <span className="truncate text-sm font-semibold text-[var(--af-text)]">{meeting.title}</span>
                            <ArrowUpRight className="h-4 w-4 shrink-0 text-[var(--af-text-3)] group-hover:text-[var(--af-accent)]" />
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-[var(--af-text-3)]">
                            <span>{formatDate(meeting.createdAt)}</span>
                            <span>/</span>
                            <span>{meeting.messageCount} message{meeting.messageCount === 1 ? '' : 's'}</span>
                            <span>/</span>
                            <span>{formatDuration(meeting.speakingSeconds)} speaking</span>
                          </span>
                          {meeting.excerpt && (
                            <span className="mt-3 block border-l-2 border-[var(--af-border-strong)] pl-3 text-xs leading-relaxed text-[var(--af-text-2)] group-hover:border-[var(--af-accent)]/60">
                              "{meeting.excerpt}"
                            </span>
                          )}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>
          </div>

          <aside className="space-y-6 lg:sticky lg:top-6">
            <section className="rounded-2xl border border-[var(--af-border)] bg-[var(--af-panel)] p-5 shadow-sm">
              <div className="flex items-center gap-2">
                <LockKeyhole className="h-4 w-4 text-[var(--af-accent)]" />
                <h2 className="font-semibold text-[var(--af-text)]">Private notes</h2>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[var(--af-text-3)]">Personal context stored with this profile. It is not added to AI questions.</p>
              <textarea
                value={notes}
                onChange={(event) => {
                  setNotes(event.target.value);
                  setNotesError(null);
                  setNotesSaved(false);
                }}
                rows={6}
                placeholder="Add role, context, preferences, or follow-ups..."
                className="mt-4 w-full resize-y rounded-xl border border-[var(--af-border-strong)] bg-[var(--af-panel-2)] px-3.5 py-3 text-sm leading-relaxed text-[var(--af-text)] placeholder:text-[var(--af-text-3)] focus:outline-none"
              />
              {notesError && <p className="mt-2 text-xs text-red-400">{notesError}</p>}
              <div className="mt-3 flex items-center justify-between gap-3">
                <span className={`text-xs ${notesSaved ? 'text-emerald-400' : 'text-[var(--af-text-3)]'}`}>
                  {notesSaved ? 'Saved' : notesDirty ? 'Unsaved changes' : 'Up to date'}
                </span>
                <button
                  onClick={saveNotes}
                  disabled={!notesDirty || savingNotes}
                  className="inline-flex items-center gap-2 rounded-lg bg-[var(--af-accent)] px-3 py-2 text-xs font-semibold text-white hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {savingNotes ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  Save notes
                </button>
              </div>
            </section>

            <section className="overflow-hidden rounded-2xl border border-[var(--af-border)] bg-[var(--af-panel)] shadow-sm">
              <div className="border-b border-[var(--af-border)] p-5">
                <div className="flex items-center gap-2">
                  <MessageSquareText className="h-4 w-4 text-cyan-400" />
                  <h2 className="font-semibold text-[var(--af-text)]">Ask about {profile.displayName.split(/\s+/)[0]}</h2>
                </div>
                <p className="mt-1 text-xs leading-relaxed text-[var(--af-text-3)]">Ask across their meeting records. Answers should cite the meeting records they use.</p>
              </div>

              {history.length > 0 && (
                <div className="max-h-80 space-y-4 overflow-y-auto p-4">
                  {history.map((message) => (
                    <div key={message.id} className="space-y-2">
                      <div className="ml-auto w-fit max-w-[92%] rounded-xl bg-[var(--af-accent)] px-3 py-2 text-xs leading-relaxed text-white">
                        {message.question}
                      </div>
                      <div className={`rounded-xl bg-[var(--af-panel-2)] px-3 py-2.5 text-xs leading-relaxed ${message.status === 'error' ? 'text-red-400' : 'text-[var(--af-text-2)]'}`}>
                        {message.status === 'pending' ? (
                          <span className="inline-flex items-center gap-2 text-[var(--af-text-3)]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the records...</span>
                        ) : message.status === 'error' ? (
                          <>Couldn't answer: {message.answer}</>
                        ) : (
                          <div className="prose prose-invert prose-xs max-w-none text-[var(--af-text-2)] prose-strong:text-[var(--af-text)] prose-p:my-1 prose-ul:my-1">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.answer}</ReactMarkdown>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <form onSubmit={askQuestion} className="p-4">
                <div className="rounded-xl border border-[var(--af-border-strong)] bg-[var(--af-panel-2)] p-2.5 focus-within:border-[var(--af-accent)]/60">
                  <textarea
                    value={question}
                    onChange={(event) => setQuestion(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey) {
                        event.preventDefault();
                        void askQuestion();
                      }
                    }}
                    rows={3}
                    placeholder="What commitments appear in their records?"
                    className="af-bare w-full resize-none bg-transparent px-1 py-1 text-sm leading-relaxed text-[var(--af-text)] placeholder:text-[var(--af-text-3)] focus:outline-none"
                  />
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-[10px] text-[var(--af-text-3)]">Enter to send / Shift+Enter for a line break</span>
                    <button
                      type="submit"
                      disabled={asking || !question.trim()}
                      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--af-accent)] text-white hover:brightness-110 disabled:opacity-40"
                      aria-label="Ask AI"
                    >
                      {asking ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </div>
              </form>

              <div className="border-t border-[var(--af-border)] bg-[var(--af-panel-2)]/50 px-4 py-3 text-[10px] leading-relaxed text-[var(--af-text-3)]">
                Uses your configured AI provider. Cloud providers may receive this person's messages and visible meeting summaries to answer your question.
              </div>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}

export default function PersonPage() {
  return (
    <Suspense fallback={<ProfileLoading />}>
      <PersonProfileContent />
    </Suspense>
  );
}
