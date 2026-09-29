/**
 * Exports one or more meetings into a single document: for each meeting its
 * notes, action items, AI summary and transcript (whichever were chosen),
 * under the meeting's title. Uses the same save dialog and formats as a
 * single meeting's export.
 */
import { invoke } from '@tauri-apps/api/core';
import { exportSummaryAs, type ExportFormat } from '@/lib/exportSummary';
import { completeSummaryMarkdown, parseSummaryData } from '@/lib/summary-markdown';
import { getMeetingNotes, listActionItems } from '@/lib/workspace-api';
import { displayTitle } from '@/lib/meeting-titles';
import { formatDuration, formatWhen, parseDate } from '@/lib/dates';

export type ExportPart = 'notes' | 'actions' | 'summary' | 'transcript';

export const EXPORT_PARTS: Array<{ id: ExportPart; label: string }> = [
  { id: 'notes', label: 'Your notes' },
  { id: 'actions', label: 'Action items' },
  { id: 'summary', label: 'AI summary' },
  { id: 'transcript', label: 'Transcript' },
];

export interface ExportableMeeting {
  id: string;
  title: string;
  created_at?: string;
  duration_seconds?: number;
  groupName?: string | null;
}

interface TranscriptRow {
  text: string;
  speaker?: string | null;
  audio_start_time?: number | null;
}

async function allTranscripts(meetingId: string): Promise<TranscriptRow[]> {
  const first = await invoke<{ total_count: number }>('api_get_meeting_transcripts', { meetingId, limit: 1, offset: 0 });
  if (!first?.total_count) return [];
  const all = await invoke<{ transcripts: TranscriptRow[] }>('api_get_meeting_transcripts', {
    meetingId,
    limit: first.total_count,
    offset: 0,
  });
  return all?.transcripts ?? [];
}

function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Pushes headings down so they sit under the meeting's own sections. */
function demoteHeadings(markdown: string, levels: number): string {
  return markdown.replace(/^(#{1,6})(\s)/gm, (_, hashes: string, space: string) => `${'#'.repeat(Math.min(6, hashes.length + levels))}${space}`);
}

export async function meetingMarkdown(meeting: ExportableMeeting, parts: Set<ExportPart>): Promise<string> {
  const start = parseDate(meeting.created_at);
  const meta = [start ? formatWhen(start) : null, formatDuration(meeting.duration_seconds) || null, meeting.groupName || null]
    .filter(Boolean)
    .join(' · ');
  const sections: string[] = [`# ${displayTitle(meeting.title, meeting.created_at)}`];
  if (meta) sections.push(`_${meta}_`);

  if (parts.has('notes')) {
    const notes = await getMeetingNotes(meeting.id).catch(() => null);
    if (notes?.markdown?.trim()) sections.push(`## Your notes\n\n${demoteHeadings(notes.markdown.trim(), 2)}`);
  }
  if (parts.has('actions')) {
    const items = await listActionItems({ meetingId: meeting.id }).catch(() => []);
    if (items.length > 0) {
      const lines = items.map((item) => {
        const owner = item.personName ?? item.ownerLabel;
        const details = [owner, item.dueText].filter(Boolean).join(', ');
        return `- [${item.done ? 'x' : ' '}] ${item.text}${details ? ` (${details})` : ''}`;
      });
      sections.push(`## Action items\n\n${lines.join('\n')}`);
    }
  }
  if (parts.has('summary')) {
    const response = await invoke<{ data?: unknown }>('api_get_summary', { meetingId: meeting.id }).catch(() => null);
    const summary = completeSummaryMarkdown(parseSummaryData(response?.data)).trim();
    if (summary) sections.push(`## AI summary\n\n${demoteHeadings(summary, 2)}`);
  }
  if (parts.has('transcript')) {
    const rows = await allTranscripts(meeting.id).catch(() => []);
    if (rows.length > 0) {
      const lines = rows.map((row) => {
        const time = row.audio_start_time != null ? `[${clock(row.audio_start_time)}] ` : '';
        const speaker = row.speaker?.trim() ? `**${row.speaker.trim()}:** ` : '';
        return `${time}${speaker}${row.text.trim()}`;
      });
      sections.push(`## Transcript\n\n${lines.join('\n\n')}`);
    }
  }
  return sections.join('\n\n');
}

/**
 * Builds the document and asks where to save it. Returns false if the user
 * cancelled the save dialog.
 */
export async function exportMeetings(
  meetings: ExportableMeeting[],
  parts: Set<ExportPart>,
  format: ExportFormat,
  onProgress?: (done: number, total: number) => void,
): Promise<boolean> {
  const documents: string[] = [];
  for (const [index, meeting] of meetings.entries()) {
    documents.push(await meetingMarkdown(meeting, parts));
    onProgress?.(index + 1, meetings.length);
  }
  const markdown = documents.join('\n\n---\n\n');
  const baseName =
    meetings.length === 1
      ? displayTitle(meetings[0].title, meetings[0].created_at)
      : `Meetings (${meetings.length}) ${new Date().toISOString().slice(0, 10)}`;
  return exportSummaryAs(format, markdown, baseName);
}
