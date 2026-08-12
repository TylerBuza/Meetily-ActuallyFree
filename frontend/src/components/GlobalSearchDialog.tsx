'use client';

/**
 * One search surface for the whole local library. Sidebar triggers and
 * Ctrl/Cmd+K open this same mounted dialog; Rust performs the actual title,
 * transcript, visible-summary, speaker, and person search so results never
 * depend on whichever transcript pages React currently has loaded.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import {
  CalendarDays,
  Clock3,
  FileText,
  Loader2,
  MessageSquareText,
  Search,
  UserRound,
} from 'lucide-react';
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import type { GlobalSearchResult } from '@/types';

function formatAudioTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`
    : `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatResultDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric',
  });
}

function resultIcon(kind: GlobalSearchResult['kind']) {
  if (kind === 'person') return <UserRound className="h-4 w-4" />;
  if (kind === 'transcript') return <MessageSquareText className="h-4 w-4" />;
  if (kind === 'summary') return <FileText className="h-4 w-4" />;
  return <CalendarDays className="h-4 w-4" />;
}

function kindLabel(kind: GlobalSearchResult['kind']): string {
  if (kind === 'transcript') return 'Transcript';
  if (kind === 'summary') return 'Summary';
  return 'Meeting';
}

export default function GlobalSearchDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<GlobalSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    const openSearch = () => setOpen(true);
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('open-global-search', openSearch);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('open-global-search', openSearch);
    };
  }, []);

  useEffect(() => {
    // Tauri invokes cannot be aborted from this component. A generation number
    // prevents a slower response for an old query from replacing newer results.
    requestIdRef.current += 1;
    const requestId = requestIdRef.current;
    const trimmed = query.trim();

    if (!open || trimmed.length < 1) {
      setResults([]);
      setLoading(false);
      setError(null);
      return;
    }

    setLoading(true);
    setError(null);
    const timer = window.setTimeout(async () => {
      try {
        const nextResults = await invoke<GlobalSearchResult[]>('api_global_search', {
          query: trimmed,
          limit: 40,
        });
        if (requestId === requestIdRef.current) setResults(nextResults);
      } catch (searchError) {
        if (requestId !== requestIdRef.current) return;
        console.error('Global search failed:', searchError);
        setResults([]);
        setError(searchError instanceof Error ? searchError.message : String(searchError));
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    }, 275);

    return () => window.clearTimeout(timer);
  }, [open, query]);

  const people = useMemo(() => results.filter((result) => result.kind === 'person'), [results]);
  const records = useMemo(() => results.filter((result) => result.kind !== 'person'), [results]);

  const close = () => {
    requestIdRef.current += 1;
    setOpen(false);
    setQuery('');
    setResults([]);
    setLoading(false);
    setError(null);
  };

  const selectResult = (result: GlobalSearchResult) => {
    if (result.kind === 'person') {
      const personId = result.personId ?? result.id;
      close();
      router.push(`/person?id=${encodeURIComponent(personId)}`);
      return;
    }

    const meetingId = result.meetingId ?? (result.kind === 'meeting' ? result.id : undefined);
    if (!meetingId) return;
    close();
    router.push(`/meeting-details?id=${encodeURIComponent(meetingId)}`);
  };

  const renderRecord = (result: GlobalSearchResult) => {
    const metadata = [
      result.kind === 'transcript' ? result.speaker : undefined,
      result.kind === 'transcript' && result.audioStartTime != null
        ? formatAudioTime(result.audioStartTime)
        : undefined,
      result.timestamp ? formatResultDate(result.timestamp) : undefined,
    ].filter(Boolean);

    return (
      <CommandItem
        key={`${result.kind}-${result.id}`}
        value={`${result.kind}-${result.id}`}
        onSelect={() => selectResult(result)}
        className="group min-h-[68px] cursor-pointer items-start gap-3 rounded-xl border border-transparent px-3 py-3 data-[selected=true]:border-[var(--af-border-strong)] data-[selected=true]:bg-[var(--af-active)]"
      >
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[var(--af-panel-2)] text-[var(--af-text-2)] group-data-[selected=true]:bg-[var(--af-accent-soft)] group-data-[selected=true]:text-[var(--af-accent)]">
          {resultIcon(result.kind)}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-[var(--af-text)]">{result.title}</span>
            <span className="shrink-0 rounded-md border border-[var(--af-border)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--af-text-3)]">
              {kindLabel(result.kind)}
            </span>
          </span>
          {result.snippet && (
            <span className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-[var(--af-text-2)]">
              {result.snippet}
            </span>
          )}
          {metadata.length > 0 && (
            <span className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--af-text-3)]">
              {result.kind === 'transcript' && <Clock3 className="h-3 w-3" />}
              {metadata.join('  /  ')}
            </span>
          )}
        </span>
      </CommandItem>
    );
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close())}
      title="Search people and meeting records"
      contentClassName="top-[44%] max-w-2xl gap-0 border-[var(--af-border-strong)] bg-[var(--af-panel)] shadow-2xl"
      commandProps={{
        shouldFilter: false,
        className: 'rounded-xl bg-[var(--af-panel)] text-[var(--af-text)]',
      }}
    >
      <div className="border-b border-[var(--af-border)] p-2 [&_[cmdk-input-wrapper]]:rounded-lg [&_[cmdk-input-wrapper]]:border [&_[cmdk-input-wrapper]]:border-[var(--af-border)] [&_[cmdk-input-wrapper]]:bg-[var(--af-panel-2)] [&_[cmdk-input-wrapper]]:px-3 [&_[cmdk-input-wrapper]]:shadow-sm [&_[cmdk-input-wrapper]]:transition-shadow [&_[cmdk-input-wrapper]]:focus-within:border-[var(--af-accent)] [&_[cmdk-input-wrapper]]:focus-within:ring-2 [&_[cmdk-input-wrapper]]:focus-within:ring-[var(--af-accent)]/25 [&_[cmdk-input-wrapper]_svg]:text-[var(--af-accent)]">
        <CommandInput
          value={query}
          onValueChange={setQuery}
          placeholder="Search people, meetings, transcripts, and summaries..."
          className="h-12 pr-10 text-[15px] text-[var(--af-text)] placeholder:text-[var(--af-text-3)]"
        />
      </div>

      <CommandList className="max-h-[min(62vh,520px)] px-2 py-2">
        {!query.trim() ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
            <span className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--af-border)] bg-[var(--af-panel-2)] text-[var(--af-accent)]">
              <Search className="h-5 w-5" />
            </span>
            <p className="text-sm font-medium text-[var(--af-text)]">Find anything you remember</p>
            <p className="mt-1 max-w-sm text-xs leading-relaxed text-[var(--af-text-3)]">
              Search a person, meeting title, spoken phrase, or detail from an AI summary.
            </p>
          </div>
        ) : loading ? (
          <div className="flex min-h-56 flex-col items-center justify-center gap-3 text-sm text-[var(--af-text-2)]">
            <Loader2 className="h-5 w-5 animate-spin text-[var(--af-accent)]" />
            Searching your meeting library...
          </div>
        ) : error ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
            <p className="text-sm font-medium text-red-400">Search is unavailable</p>
            <p className="mt-1 max-w-md text-xs leading-relaxed text-[var(--af-text-3)]">{error}</p>
          </div>
        ) : results.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center px-8 text-center">
            <p className="text-sm font-medium text-[var(--af-text)]">No results for "{query.trim()}"</p>
            <p className="mt-1 text-xs text-[var(--af-text-3)]">Try a name, topic, or a shorter phrase.</p>
          </div>
        ) : (
          <>
            {people.length > 0 && (
              <CommandGroup
                heading="People"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-[var(--af-text-3)]"
              >
                {people.map((result) => (
                  <CommandItem
                    key={`person-${result.id}`}
                    value={`person-${result.id}`}
                    onSelect={() => selectResult(result)}
                    className="group min-h-[62px] cursor-pointer gap-3 rounded-xl border border-transparent px-3 py-2.5 data-[selected=true]:border-[var(--af-border-strong)] data-[selected=true]:bg-[var(--af-active)]"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#5b8cff] to-[#7357d8] text-sm font-semibold text-white shadow-sm">
                      {result.title.trim().charAt(0).toUpperCase() || '?'}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-[var(--af-text)]">{result.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-[var(--af-text-2)]">
                        {result.snippet || 'View meeting history and conversation profile'}
                      </span>
                    </span>
                    {result.meetingCount != null && (
                      <span className="shrink-0 text-xs tabular-nums text-[var(--af-text-3)]">
                        {result.meetingCount} meeting{result.meetingCount === 1 ? '' : 's'}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {people.length > 0 && records.length > 0 && <CommandSeparator className="mx-3 my-2 bg-[var(--af-border)]" />}
            {records.length > 0 && (
              <CommandGroup
                heading="Meetings, transcripts & summaries"
                className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.14em] [&_[cmdk-group-heading]]:text-[var(--af-text-3)]"
              >
                {records.map(renderRecord)}
              </CommandGroup>
            )}
          </>
        )}
      </CommandList>

      <div className="flex items-center gap-4 border-t border-[var(--af-border)] px-4 py-2 text-[10px] text-[var(--af-text-3)]">
        <span><kbd className="mr-1 rounded border border-[var(--af-border-strong)] bg-[var(--af-panel-2)] px-1.5 py-0.5">Arrows</kbd> navigate</span>
        <span><kbd className="mr-1 rounded border border-[var(--af-border-strong)] bg-[var(--af-panel-2)] px-1.5 py-0.5">Enter</kbd> open</span>
        <span className="ml-auto"><kbd className="mr-1 rounded border border-[var(--af-border-strong)] bg-[var(--af-panel-2)] px-1.5 py-0.5">Esc</kbd> close</span>
      </div>
    </CommandDialog>
  );
}
