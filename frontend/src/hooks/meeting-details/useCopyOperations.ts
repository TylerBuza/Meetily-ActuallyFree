import { useCallback, RefObject } from 'react';
import { Transcript, Summary } from '@/types';
import { BlockNoteSummaryViewRef } from '@/components/AISummary/BlockNoteSummaryView';
import { toast } from 'sonner';
import Analytics from '@/lib/analytics';
import { invoke as invokeTauri } from '@tauri-apps/api/core';
import { exportSummaryAs, ExportFormat } from '@/lib/exportSummary';

export type MeetingExportContent = 'transcript' | 'summary' | 'both';
export type MeetingExportFormat = ExportFormat | 'clipboard';

function blockContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(blockContentToText).join('');
  if (content && typeof content === 'object') {
    const node = content as { text?: unknown; content?: unknown };
    if (typeof node.text === 'string') return node.text;
    return blockContentToText(node.content);
  }
  return '';
}

function blockNoteToMarkdown(blocks: unknown[]): string {
  const lines: string[] = [];
  const appendBlocks = (items: unknown[]) => {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const block = item as {
        type?: string;
        props?: { level?: number };
        content?: unknown;
        children?: unknown[];
      };
      const text = blockContentToText(block.content).trim();
      if (text) {
        if (block.type === 'heading') {
          const level = Math.min(6, Math.max(1, Number(block.props?.level) || 2));
          lines.push(`${'#'.repeat(level)} ${text}`);
        } else if (block.type === 'numberedListItem') {
          lines.push(`1. ${text}`);
        } else if (block.type === 'bulletListItem' || block.type === 'checkListItem') {
          lines.push(`- ${text}`);
        } else {
          lines.push(text);
        }
      }
      if (Array.isArray(block.children)) appendBlocks(block.children);
    }
  };
  appendBlocks(blocks);
  return lines.join('\n\n');
}

interface UseCopyOperationsProps {
  meeting: any;
  transcripts: Transcript[];
  meetingTitle: string;
  aiSummary: Summary | null;
  blockNoteSummaryRef: RefObject<BlockNoteSummaryViewRef>;
}

export function useCopyOperations({
  meeting,
  transcripts,
  meetingTitle,
  aiSummary,
  blockNoteSummaryRef,
}: UseCopyOperationsProps) {

  // Helper function to fetch ALL transcripts for copying (not just paginated data)
  const fetchAllTranscripts = useCallback(async (meetingId: string): Promise<Transcript[]> => {
    try {
      console.log('📊 Fetching all transcripts for copying:', meetingId);

      // First, get total count by fetching first page
      const firstPage = await invokeTauri('api_get_meeting_transcripts', {
        meetingId,
        limit: 1,
        offset: 0,
      }) as { transcripts: Transcript[]; total_count: number; has_more: boolean };

      const totalCount = firstPage.total_count;
      console.log(`📊 Total transcripts in database: ${totalCount}`);

      if (totalCount === 0) {
        return [];
      }

      // Fetch all transcripts in one call
      const allData = await invokeTauri('api_get_meeting_transcripts', {
        meetingId,
        limit: totalCount,
        offset: 0,
      }) as { transcripts: Transcript[]; total_count: number; has_more: boolean };

      console.log(`✅ Fetched ${allData.transcripts.length} transcripts from database for copying`);
      return allData.transcripts;
    } catch (error) {
      console.error('❌ Error fetching all transcripts:', error);
      toast.error('Failed to fetch transcripts for copying');
      return [];
    }
  }, []);

  // Copy transcript to clipboard
  const handleCopyTranscript = useCallback(async () => {
    // CHANGE: Fetch ALL transcripts from database, not from pagination state
    console.log('📊 Fetching all transcripts for copying...');
    const allTranscripts = await fetchAllTranscripts(meeting.id);

    if (!allTranscripts.length) {
      const error_msg = 'No transcripts available to copy';
      console.log(error_msg);
      toast.error(error_msg);
      return;
    }

    console.log(`✅ Copying ${allTranscripts.length} transcripts to clipboard`);

    // Format timestamps as recording-relative [MM:SS] instead of wall-clock time
    const formatTime = (seconds: number | undefined, fallbackTimestamp: string): string => {
      if (seconds === undefined) {
        // For old transcripts without audio_start_time, use wall-clock time
        return fallbackTimestamp;
      }
      const totalSecs = Math.floor(seconds);
      const mins = Math.floor(totalSecs / 60);
      const secs = totalSecs % 60;
      return `[${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}]`;
    };

    const header = `# Transcript of the Meeting: ${meeting.id} - ${meetingTitle ?? meeting.title}\n\n`;
    const date = `## Date: ${new Date(meeting.created_at).toLocaleDateString()}\n\n`;
    const fullTranscript = allTranscripts
      .map(t => `${formatTime(t.audio_start_time, t.timestamp)} ${t.text}  `)
      .join('\n');

    await navigator.clipboard.writeText(header + date + fullTranscript);
    toast.success("Transcript copied to clipboard");

    // Track copy analytics
    const wordCount = allTranscripts
      .map(t => t.text.split(/\s+/).length)
      .reduce((a, b) => a + b, 0);

    await Analytics.trackCopy('transcript', {
      meeting_id: meeting.id,
      transcript_length: allTranscripts.length.toString(),
      word_count: wordCount.toString()
    });
  }, [meeting, meetingTitle, fetchAllTranscripts]);

  // Copy summary to clipboard
  const handleCopySummary = useCallback(async () => {
    try {
      let summaryMarkdown = '';

      console.log('🔍 Copy Summary - Starting...');

      // Try to get markdown from BlockNote editor first
      if (blockNoteSummaryRef.current?.getMarkdown) {
        console.log('📝 Trying to get markdown from ref...');
        summaryMarkdown = await blockNoteSummaryRef.current.getMarkdown();
        console.log('📝 Got markdown from ref, length:', summaryMarkdown.length);
      }

      // Fallback: Check if aiSummary has markdown property
      if (!summaryMarkdown && aiSummary && 'markdown' in aiSummary) {
        console.log('📝 Using markdown from aiSummary');
        summaryMarkdown = (aiSummary as any).markdown || '';
        console.log('📝 Markdown from aiSummary, length:', summaryMarkdown.length);
      }

      if (!summaryMarkdown && Array.isArray((aiSummary as any)?.summary_json)) {
        summaryMarkdown = blockNoteToMarkdown((aiSummary as any).summary_json);
      }

      // Fallback: Check for legacy format
      if (!summaryMarkdown && aiSummary) {
        console.log('📝 Converting legacy format to markdown');
        const sections = Object.entries(aiSummary)
          .filter(([key]) => {
            // Skip non-section keys
            return key !== 'markdown' && key !== 'summary_json' && key !== '_section_order' && key !== 'MeetingName';
          })
          .map(([, section]) => {
            if (section && typeof section === 'object' && 'title' in section && 'blocks' in section) {
              const sectionTitle = `## ${section.title}\n\n`;
              const sectionContent = section.blocks
                .map((block: any) => `- ${block.content}`)
                .join('\n');
              return sectionTitle + sectionContent;
            }
            return '';
          })
          .filter(s => s.trim())
          .join('\n\n');
        summaryMarkdown = sections;
        console.log('📝 Converted legacy format, length:', summaryMarkdown.length);
      }

      // If still no summary content, show message
      if (!summaryMarkdown.trim()) {
        console.error('❌ No summary content available to copy');
        toast.error('No summary content available to copy');
        return;
      }

      // Build metadata header
      const header = `# Meeting Summary: ${meetingTitle}\n\n`;
      const metadata = `**Meeting ID:** ${meeting.id}\n**Date:** ${new Date(meeting.created_at).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })}\n**Copied on:** ${new Date().toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      })}\n\n---\n\n`;

      const fullMarkdown = header + metadata + summaryMarkdown;
      await navigator.clipboard.writeText(fullMarkdown);

      console.log('✅ Successfully copied to clipboard!');
      toast.success("Summary copied to clipboard");

      // Track copy analytics
      await Analytics.trackCopy('summary', {
        meeting_id: meeting.id,
        has_markdown: (!!aiSummary && 'markdown' in aiSummary).toString()
      });
    } catch (error) {
      console.error('❌ Failed to copy summary:', error);
      toast.error("Failed to copy summary");
    }
  }, [aiSummary, meetingTitle, meeting, blockNoteSummaryRef]);

  // Build the same summary markdown used for copying (header + metadata + content)
  const getSummaryMarkdown = useCallback(async (): Promise<string | null> => {
    let summaryMarkdown = '';
    if (blockNoteSummaryRef.current?.getMarkdown) {
      summaryMarkdown = await blockNoteSummaryRef.current.getMarkdown();
    }
    if (!summaryMarkdown && aiSummary && 'markdown' in aiSummary) {
      summaryMarkdown = (aiSummary as any).markdown || '';
    }
    if (!summaryMarkdown && Array.isArray((aiSummary as any)?.summary_json)) {
      summaryMarkdown = blockNoteToMarkdown((aiSummary as any).summary_json);
    }
    if (!summaryMarkdown && aiSummary) {
      summaryMarkdown = Object.entries(aiSummary)
        .filter(([key]) => key !== 'markdown' && key !== 'summary_json' && key !== '_section_order' && key !== 'MeetingName')
        .map(([, section]: any) => {
          if (section && typeof section === 'object' && 'title' in section && 'blocks' in section) {
            const title = `## ${section.title}\n\n`;
            const content = section.blocks.map((block: any) => `- ${block.content}`).join('\n');
            return title + content;
          }
          return '';
        })
        .filter((s) => s.trim())
        .join('\n\n');
    }
    if (!summaryMarkdown.trim()) return null;

    const header = `# Meeting Summary: ${meetingTitle}\n\n`;
    const metadata = `**Meeting ID:** ${meeting.id}\n**Date:** ${new Date(meeting.created_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    })}\n\n---\n\n`;
    return header + metadata + summaryMarkdown;
  }, [aiSummary, meetingTitle, meeting, blockNoteSummaryRef]);

  const getTranscriptMarkdown = useCallback(async (): Promise<string | null> => {
    const allTranscripts = await fetchAllTranscripts(meeting.id);
    if (!allTranscripts.length) return null;

    const formatTime = (seconds: number | undefined, fallbackTimestamp: string): string => {
      if (seconds === undefined) return fallbackTimestamp;
      const totalSeconds = Math.floor(seconds);
      const minutes = Math.floor(totalSeconds / 60);
      const remainder = totalSeconds % 60;
      return `[${minutes.toString().padStart(2, '0')}:${remainder.toString().padStart(2, '0')}]`;
    };

    const body = allTranscripts
      .map((transcript) => {
        const speaker = transcript.speaker ? ` **${transcript.speaker}:**` : '';
        return `${formatTime(transcript.audio_start_time, transcript.timestamp)}${speaker} ${transcript.text}`;
      })
      .join('\n\n');
    const date = new Date(meeting.created_at).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });

    return `# Meeting Transcript: ${meetingTitle}\n\n**Meeting ID:** ${meeting.id}\n**Date:** ${date}\n\n---\n\n${body}`;
  }, [fetchAllTranscripts, meeting.id, meeting.created_at, meetingTitle]);

  // Export summary to a file (Markdown, PDF, or DOCX)
  const handleExportSummary = useCallback(async (format: ExportFormat) => {
    try {
      const md = await getSummaryMarkdown();
      if (!md) {
        toast.error('No summary content available to export');
        return;
      }
      const baseName = String(meetingTitle || meeting?.title || 'summary');
      await exportSummaryAs(format, md, baseName);
      toast.success(`Summary exported as ${format.toUpperCase()}`);
      try {
        await Analytics.trackFeatureUsed(`export_summary_${format}`);
      } catch { /* analytics is best-effort */ }
    } catch (error) {
      console.error('❌ Failed to export summary:', error);
      toast.error('Failed to export summary');
    }
  }, [getSummaryMarkdown, meetingTitle, meeting]);

  const handleExportMeeting = useCallback(async (
    content: MeetingExportContent,
    format: MeetingExportFormat,
  ): Promise<boolean> => {
    try {
      const transcriptMarkdown = content === 'summary' ? null : await getTranscriptMarkdown();
      const summaryMarkdown = content === 'transcript' ? null : await getSummaryMarkdown();

      if (content !== 'summary' && !transcriptMarkdown) {
        toast.error('No transcript content available to export');
        return false;
      }
      if (content !== 'transcript' && !summaryMarkdown) {
        toast.error('No summary content available to export');
        return false;
      }

      const markdown = content === 'transcript'
        ? transcriptMarkdown!
        : content === 'summary'
          ? summaryMarkdown!
          : `${transcriptMarkdown!}\n\n---\n\n${summaryMarkdown!}`;
      const baseName = `${String(meetingTitle || meeting?.title || 'meeting')}-${content}`;

      if (format === 'clipboard') {
        await navigator.clipboard.writeText(markdown);
        toast.success(`${content === 'both' ? 'Transcript and summary' : content} copied to clipboard`);
      } else {
        await exportSummaryAs(format, markdown, baseName);
        toast.success(`Meeting exported as ${format.toUpperCase()}`);
      }

      try {
        await Analytics.trackFeatureUsed(`export_meeting_${content}_${format}`);
      } catch { /* analytics is best-effort */ }
      return true;
    } catch (error) {
      console.error('Failed to export meeting:', error);
      toast.error('Failed to export meeting');
      return false;
    }
  }, [getTranscriptMarkdown, getSummaryMarkdown, meetingTitle, meeting]);

  return {
    handleCopyTranscript,
    handleCopySummary,
    handleExportSummary,
    handleExportMeeting,
  };
}
