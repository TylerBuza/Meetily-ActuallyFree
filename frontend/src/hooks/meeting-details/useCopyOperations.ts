/**
 * Copy and export for the meeting page. The transcript always comes from the
 * database (every line, not only the pages loaded on screen), with speaker
 * names; the summary is read from whatever format it is stored in.
 */
import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import { exportSummaryAs, type ExportFormat } from '@/lib/exportSummary';
import { completeSummaryMarkdown, parseSummaryData } from '@/lib/summary-markdown';
import { displayTitle } from '@/lib/meeting-titles';
import { useUserName } from '@/hooks/useUserName';
import { displaySpeaker, splitSpeakerLabel } from '@/utils/speakerUtils';
import { buildFrontmatter, formatSpeakerMention, type LinkStyle } from '@/lib/exportMarkdownFrontmatter';
import { isLinkableSpeakerName } from '@/lib/speakerLabels';
import type { Summary, Transcript } from '@/types';

export type MeetingExportContent = 'transcript' | 'summary' | 'both';
export type MeetingExportFormat = ExportFormat | 'clipboard';

interface UseCopyOperationsProps {
  meeting: { id: string; title?: string; created_at: string };
  meetingTitle?: string;
  aiSummary: Summary | null;
}

function stamp(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `[${h}:${m}:${s}] ` : `[${m}:${s}] `;
}

async function allTranscripts(meetingId: string): Promise<Transcript[]> {
  const first = await invoke<{ total_count: number }>('api_get_meeting_transcripts', { meetingId, limit: 1, offset: 0 });
  if (!first?.total_count) return [];
  const all = await invoke<{ transcripts: Transcript[] }>('api_get_meeting_transcripts', { meetingId, limit: first.total_count, offset: 0 });
  return all?.transcripts ?? [];
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function useCopyOperations({ meeting, meetingTitle, aiSummary }: UseCopyOperationsProps) {
  const userName = useUserName();
  const title = displayTitle(meetingTitle || meeting.title, meeting.created_at);
  const dateLine = new Date(meeting.created_at).toLocaleDateString(undefined, {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const transcriptBody = useCallback(async (linkStyle?: LinkStyle, sourceRows?: Transcript[]): Promise<string | null> => {
    const rows = sourceRows ?? await allTranscripts(meeting.id);
    if (rows.length === 0) return null;
    return rows
      .map((row) => {
        const speaker = row.speaker?.trim() ? (linkStyle
          ? `${formatSpeakerMention(row.speaker.trim(), linkStyle, userName)} `
          : `**${displaySpeaker(row.speaker.trim(), userName)}:** `) : '';
        return `${stamp(row.audio_start_time)}${speaker}${row.text.trim()}`;
      })
      .join('\n\n');
  }, [meeting.id, userName]);

  const summaryBody = useCallback((): string | null => {
    const body = completeSummaryMarkdown(parseSummaryData(aiSummary)).trim();
    return body || null;
  }, [aiSummary]);

  const document = useCallback(
    (sections: Array<[string, string]>) =>
      [`# ${title}`, `_${dateLine}_`, ...sections.map(([heading, body]) => `## ${heading}\n\n${body}`)].join('\n\n'),
    [title, dateLine],
  );

  const handleCopyTranscript = useCallback(async () => {
    try {
      const body = await transcriptBody();
      if (!body) {
        toast.error('There is no transcript to copy yet');
        return;
      }
      await navigator.clipboard.writeText(document([['Transcript', body]]));
      toast.success('Transcript copied');
      await Analytics.trackCopy('transcript', { meeting_id: meeting.id }).catch(() => undefined);
    } catch (error) {
      toast.error('Could not copy the transcript', { description: message(error) });
    }
  }, [transcriptBody, document, meeting.id]);

  const handleCopySummary = useCallback(async () => {
    try {
      const body = summaryBody();
      if (!body) {
        toast.error('There is no summary to copy yet');
        return;
      }
      await navigator.clipboard.writeText(document([['Summary', body]]));
      toast.success('Summary copied');
      await Analytics.trackCopy('summary', { meeting_id: meeting.id }).catch(() => undefined);
    } catch (error) {
      toast.error('Could not copy the summary', { description: message(error) });
    }
  }, [summaryBody, document, meeting.id]);

  const handleExportMeeting = useCallback(
    async (content: MeetingExportContent, format: MeetingExportFormat, linkStyle: LinkStyle = 'generic'): Promise<boolean> => {
      try {
        // Fetch once for both Markdown frontmatter and transcript content. Other
        // formats keep their existing rendering and do not receive wikilinks.
        const rows = format === 'markdown' ? await allTranscripts(meeting.id) : undefined;
        const sections: Array<[string, string]> = [];
        if (content !== 'transcript') {
          const body = summaryBody();
          if (!body) {
            toast.error('There is no summary to export yet');
            return false;
          }
          sections.push(['Summary', body.replace(/^(#{1,5})(\s)/gm, '#$1$2')]);
        }
        if (content !== 'summary') {
          const body = await transcriptBody(format === 'markdown' ? linkStyle : undefined, rows);
          if (!body) {
            toast.error('There is no transcript to export yet');
            return false;
          }
          sections.push(['Transcript', body]);
        }
        let markdown = document(sections);
        if (format === 'markdown') {
          const attendees = [...new Set((rows ?? []).flatMap(row => splitSpeakerLabel(row.speaker ?? '')))]
            .filter(isLinkableSpeakerName);
          markdown = `${buildFrontmatter({ title, meetingId: meeting.id, date: new Date(meeting.created_at), attendees, linkStyle })}\n\n${markdown}`;
        }
        if (format === 'clipboard') {
          await navigator.clipboard.writeText(markdown);
          toast.success(content === 'both' ? 'Transcript and summary copied' : `${content === 'summary' ? 'Summary' : 'Transcript'} copied`);
        } else {
          const saved = await exportSummaryAs(format, markdown, `${title} ${content === 'both' ? '' : content}`.trim());
          if (!saved) return false;
          toast.success(`Exported as ${format === 'markdown' ? 'Markdown' : format.toUpperCase()}`);
        }
        await Analytics.trackFeatureUsed(`export_meeting_${content}_${format}`).catch(() => undefined);
        return true;
      } catch (error) {
        toast.error('Export failed', { description: message(error) });
        return false;
      }
    },
    [summaryBody, transcriptBody, document, title, meeting.id, meeting.created_at],
  );

  return { handleCopyTranscript, handleCopySummary, handleExportMeeting };
}
