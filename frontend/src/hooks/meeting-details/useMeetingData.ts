import { useEffect, useState } from 'react';
import type { Summary, Transcript } from '@/types';

interface UseMeetingDataProps {
  meeting: { id: string; transcripts: Transcript[]; speakers?: string[] };
  summaryData: Summary | null;
}

/** The meeting page's transcript and its current summary. */
export function useMeetingData({ meeting, summaryData }: UseMeetingDataProps) {
  const [aiSummary, setAiSummary] = useState<Summary | null>(summaryData);

  // Take a newly loaded summary, but never replace a just-generated one with
  // `null` when the parent re-renders before it has reloaded.
  useEffect(() => {
    if (summaryData) setAiSummary(summaryData);
  }, [summaryData]);

  // A different meeting starts from whatever the parent loaded for it.
  useEffect(() => {
    setAiSummary(summaryData);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meeting.id]);

  return { transcripts: meeting.transcripts, speakers: meeting.speakers, aiSummary, setAiSummary };
}
