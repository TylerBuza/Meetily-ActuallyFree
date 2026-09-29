/**
 * Keeps a meeting's action item rows in step with its AI summary.
 *
 * When a summary contains an action section, its items become rows (linked to
 * contacts by Rust) and the section is removed from the summary so the
 * meeting shows each item once. The untrimmed text is kept on the summary as
 * `original_markdown`. Summaries without a recognisable action section are
 * never modified.
 */
import { invoke } from '@tauri-apps/api/core';
import { extractActionItems, fingerprint, locateInTranscript } from '@/lib/action-items';
import { completeSummaryMarkdown, parseSummaryData } from '@/lib/summary-markdown';
import { announceChange, listUnsyncedActionMeetings, syncAiActionItems, type ActionItem } from '@/lib/workspace-api';

export interface TranscriptLine {
  id: string;
  timestamp: number;
  text: string;
}

export interface SyncOutcome {
  changed: boolean;
  items?: ActionItem[];
  /** The summary as saved after its action section was moved out. */
  summary?: { markdown: string; original_markdown: string };
}

export async function syncMeetingActionItems(
  meetingId: string,
  summaryData: unknown,
  transcript?: TranscriptLine[],
): Promise<SyncOutcome> {
  const data = parseSummaryData(summaryData);
  const markdown = completeSummaryMarkdown(data);
  if (!markdown.trim()) return { changed: false };
  const result = extractActionItems(markdown);
  if (!result.hadActionSection) return { changed: false };

  const drafts = result.drafts.map((draft) => {
    const located = transcript?.length ? locateInTranscript(draft.text, transcript) : null;
    return { ...draft, audioTime: located?.audioTime ?? null, transcriptId: located?.transcriptId ?? null };
  });
  const items = await syncAiActionItems(meetingId, drafts, fingerprint(result.remainingMarkdown));
  const summary = {
    markdown: result.remainingMarkdown,
    original_markdown: typeof data?.original_markdown === 'string' ? data.original_markdown : markdown,
  };
  await invoke('api_save_meeting_summary', { meetingId, summary, userEdit: false });
  announceChange('actions', { meetingId });
  return { changed: true, items, summary };
}

const BACKFILL_KEY = 'af-action-backfill-done';
const BACKFILL_LIMIT = 400;
const BACKFILL_TRANSCRIPT_LINES = 4000;

/** The saved transcript, so extracted items can link to the moment they were said. */
async function transcriptLines(meetingId: string): Promise<TranscriptLine[]> {
  try {
    const response = await invoke<{ transcripts: Array<{ id: string; text: string; audio_start_time?: number | null }> }>(
      'api_get_meeting_transcripts',
      { meetingId, limit: BACKFILL_TRANSCRIPT_LINES, offset: 0 },
    );
    return (response?.transcripts ?? []).map((line) => ({ id: line.id, text: line.text, timestamp: line.audio_start_time ?? 0 }));
  } catch {
    return [];
  }
}

/** Reads action items out of meetings summarised before they were records. */
export async function backfillActionItems(): Promise<void> {
  try {
    if (sessionStorage.getItem(BACKFILL_KEY)) return;
    sessionStorage.setItem(BACKFILL_KEY, '1');
  } catch {
    // Without session storage the backfill may simply run again next launch.
  }
  let ids: string[] = [];
  try {
    ids = await listUnsyncedActionMeetings();
  } catch (error) {
    console.warn('[actions] Could not list meetings to backfill', error);
    return;
  }
  let changed = 0;
  for (const meetingId of ids.slice(0, BACKFILL_LIMIT)) {
    try {
      const response = await invoke<{ data?: unknown }>('api_get_summary', { meetingId });
      const hasSection = extractActionItems(completeSummaryMarkdown(parseSummaryData(response?.data))).hadActionSection;
      const outcome = await syncMeetingActionItems(meetingId, response?.data, hasSection ? await transcriptLines(meetingId) : undefined);
      if (outcome.changed) {
        changed += 1;
      } else {
        // Nothing to extract: record that this summary was read.
        const markdown = completeSummaryMarkdown(parseSummaryData(response?.data));
        await syncAiActionItems(meetingId, [], fingerprint(markdown));
      }
    } catch (error) {
      console.warn('[actions] Backfill skipped a meeting', meetingId, error);
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  if (changed > 0) announceChange('actions');
}
