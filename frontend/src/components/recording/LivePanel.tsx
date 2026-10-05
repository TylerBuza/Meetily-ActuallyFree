'use client';

/**
 * The right-hand panel while recording: who is talking (and naming them),
 * notes typed during the call, and Ask AI about the call so far.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { NotebookPen, Sparkles, UserCheck, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Hint } from '@/components/ui/tooltip';
import { NotesEditor, type NotesContent } from '@/components/editor/NotesEditor';
import { MeetingImages } from '@/components/meeting/MeetingImages';
import { ChatThread } from '@/components/chat/ChatThread';
import { PossibleVoiceMatch } from '@/components/people/PossibleVoiceMatch';
import { useUserName } from '@/hooks/useUserName';
import { displaySpeaker, isUserSpeaker, speakerDot, speakerKey } from '@/utils/speakerUtils';
import { buildLiveContext, lineAt, type LiveLine } from '@/lib/live-context';
import { readLiveNotes, writeLiveNotes } from '@/lib/live-session';
import type { DetectedSpeaker } from '@/types';

export type LivePanelTab = 'speakers' | 'notes' | 'ask';

const NOTES_SAVE_DELAY = 400;

function SpeakersTab({
  speakers,
  onIdentify,
  onMarkMe,
  speakerChannels,
}: {
  speakers: DetectedSpeaker[];
  speakerChannels?: Map<string, string>;
  onIdentify: (speaker: string) => void;
  onMarkMe: (speaker: string) => void;
}) {
  const userName = useUserName();
  const total = speakers.reduce((sum, speaker) => sum + speaker.segmentCount, 0);
  // One row per person: labels that all mean the user, or differ only in case, share a row.
  const sorted = useMemo(() => {
    const byPerson = new Map<string, DetectedSpeaker>();
    for (const speaker of [...speakers].sort((a, b) => b.segmentCount - a.segmentCount)) {
      const key = speaker.isUser ? speakerKey('You') : speakerKey(speaker.name);
      const kept = byPerson.get(key);
      byPerson.set(
        key,
        kept
          ? { ...kept, segmentCount: kept.segmentCount + speaker.segmentCount, lastSpokeAt: Math.max(kept.lastSpokeAt ?? 0, speaker.lastSpokeAt ?? 0) || undefined }
          : speaker,
      );
    }
    return [...byPerson.values()];
  }, [speakers]);

  if (speakers.length === 0) {
    return (
      <div className="flex flex-col items-center px-6 py-14 text-center">
        <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-af-border bg-af-panel-2 text-af-text-3">
          <Users className="h-4 w-4" />
        </span>
        <p className="text-[13px] font-medium text-af-text">No voices yet</p>
        <p className="mt-1 max-w-[15rem] text-xs leading-relaxed text-af-text-3">Each person shows up here as they start talking.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <ul className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3">
        {sorted.map((speaker) => {
          const you = speaker.isUser || isUserSpeaker(speaker.name);
          const share = total > 0 ? Math.round((speaker.segmentCount / total) * 100) : 0;
          return (
            <li key={speaker.id} className="group/speaker relative">
              <div className="flex items-start gap-1">
              <button
                type="button"
                onClick={() => onIdentify(speaker.name)}
                className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors hover:bg-af-hover"
              >
                <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', speakerDot(speaker.name, speaker.colorIndex))} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-af-text">{displaySpeaker(speaker.name, userName)}</span>
                  <span className="mt-1 flex items-center gap-2">
                    <span className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-af-border">
                      <span
                        className="block h-full rounded-full bg-af-text-4 transition-[width] duration-500 ease-af"
                        style={{ width: `${Math.max(4, share)}%` }}
                      />
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-af-text-4">{share}%</span>
                  </span>
                </span>
              </button>
              {!you && <PossibleVoiceMatch speaker={speaker.name} speakerChannel={speakerChannels?.get(speaker.name)} review inline onAccept={() => onIdentify(speaker.name)} />}
              {!you && (
                <Hint label="This is me">
                  <button
                    type="button"
                    onClick={() => onMarkMe(speaker.name)}
                    aria-label={`${speaker.name} is me`}
                    className="mt-2 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-af-panel text-af-text-3 opacity-0 shadow-sm ring-1 ring-af-border transition-[opacity,color] hover:text-af-accent focus-visible:opacity-100 group-hover/speaker:opacity-100"
                  >
                    <UserCheck className="h-3.5 w-3.5" />
                  </button>
                </Hint>
              )}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="shrink-0 border-t border-af-border px-4 py-3 text-[11px] leading-relaxed text-af-text-4">
        Click a speaker to name them from your contacts or add someone new. Names are saved as contacts when the recording ends.
      </p>
    </div>
  );
}

function NotesTab() {
  // Read once: the editor owns the content after that.
  const [initial] = useState(() => readLiveNotes());
  const timer = useRef<number | null>(null);
  const latest = useRef<NotesContent | null>(null);

  const flush = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    if (latest.current) writeLiveNotes({ markdown: latest.current.markdown, json: latest.current.json });
  }, []);

  useEffect(() => flush, [flush]);

  return (
    <div className="h-full overflow-y-auto px-5 py-4 pl-11">
      <MeetingImages live><NotesEditor
        initialBlocks={initial?.json ?? null}
        initialMarkdown={initial?.json ? null : initial?.markdown ?? null}
        placeholder="Type notes as the call goes. They are saved to this meeting when you stop."
        onChange={(content) => {
          latest.current = content;
          if (timer.current !== null) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(flush, NOTES_SAVE_DELAY);
        }}
      /></MeetingImages>
    </div>
  );
}

export function LivePanel({
  tab,
  onTabChange,
  speakers,
  lines,
  sessionKey,
  onIdentify,
  onMarkMe,
  speakerChannels,
  onJumpTo,
}: {
  tab: LivePanelTab;
  onTabChange: (tab: LivePanelTab) => void;
  speakers: DetectedSpeaker[];
  speakerChannels?: Map<string, string>;
  lines: LiveLine[];
  /** Changes per recording, so each call gets its own Ask AI thread. */
  sessionKey: string;
  onIdentify: (speaker: string) => void;
  onMarkMe: (speaker: string) => void;
  /** A cited moment was clicked. */
  onJumpTo: (lineId: string) => void;
}) {
  const userName = useUserName();
  const linesRef = useRef(lines);
  linesRef.current = lines;

  const ask = useCallback(
    async (question: string, history: Array<{ question: string; answer: string }>) => {
      const context = buildLiveContext(linesRef.current, question, 12_000, (speaker) =>
        isUserSpeaker(speaker) ? `${userName || 'The user'} (the user)` : speaker,
      );
      const notes = readLiveNotes()?.markdown.trim();
      const guidance = [
        'When you rely on something said in the call, cite its timestamp in square brackets, like [12:34].',
        notes ? `The user's own notes from this call:\n${notes.slice(0, 3_000)}` : '',
        history.length
          ? `Earlier in this conversation:\n${history
              .slice(-4)
              .map((turn) => `Q: ${turn.question}\nA: ${turn.answer.slice(0, 800)}`)
              .join('\n\n')}`
          : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      if (!context.trim()) throw new Error('Nothing has been said yet. Ask again once the transcript has some lines.');
      return invoke<string>('ask_live_assistant', { question, transcriptContext: context, persona: guidance });
    },
    [userName],
  );

  return (
    <Tabs value={tab} onValueChange={(value) => onTabChange(value as LivePanelTab)} className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-af-border px-3 py-2.5">
        <TabsList className="grid w-full grid-cols-3">
          <TabsTrigger value="speakers">
            <Users />
            Speakers
            {speakers.length > 0 && <span className="text-[11px] tabular-nums text-af-text-4">{speakers.length}</span>}
          </TabsTrigger>
          <TabsTrigger value="notes">
            <NotebookPen />
            Notes
          </TabsTrigger>
          <TabsTrigger value="ask">
            <Sparkles />
            Ask AI
          </TabsTrigger>
        </TabsList>
      </div>
      {/* Notes stay mounted so switching tabs never drops a keystroke. */}
      <TabsContent value="speakers" className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
        <SpeakersTab speakerChannels={speakerChannels} speakers={speakers} onIdentify={onIdentify} onMarkMe={onMarkMe} />
      </TabsContent>
      <TabsContent value="notes" forceMount className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
        <NotesTab key={sessionKey} />
      </TabsContent>
      <TabsContent value="ask" className="mt-0 min-h-0 flex-1 data-[state=inactive]:hidden">
        <ChatThread
          historyKey={`live:${sessionKey}`}
          ask={ask}
          compact
          emptyTitle="Ask about this call"
          emptyHint="Answers come from what has been said so far and your notes."
          suggestions={['What did I miss in the last 5 minutes?', 'What has been decided?', 'Which action items came up?', 'What questions are still open?']}
          placeholder="Ask about the call…"
          footnote="Uses your summary model. Cloud providers receive the parts of the transcript needed to answer."
          onSeek={(seconds) => {
            const target = lineAt(linesRef.current, seconds);
            if (target) onJumpTo(target.id);
          }}
        />
      </TabsContent>
    </Tabs>
  );
}

