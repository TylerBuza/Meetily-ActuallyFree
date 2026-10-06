import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react';
import type { Summary, Transcript } from '@/types';

interface UseMeetingDataProps {
  meeting: { id: string; transcripts: Transcript[]; speakers?: string[] };
  summaryData: Summary | null;
}

/** The meeting page's transcript and its current summary. */
export function useMeetingData({ meeting, summaryData }: UseMeetingDataProps) {
  const activeMeeting = useRef(meeting.id);
  activeMeeting.current = meeting.id;
  const [state, setState] = useState({meetingId: meeting.id, summary: summaryData});
  const setAiSummary = useCallback((next: SetStateAction<Summary | null>) => {
    if (activeMeeting.current !== meeting.id) return;
    setState(previous => ({meetingId: meeting.id, summary: typeof next === 'function'
      ? next(previous.meetingId === meeting.id ? previous.summary : summaryData) : next}));
  }, [meeting.id, summaryData]);
  useEffect(() => {
    setState(previous => summaryData || previous.meetingId !== meeting.id
      ? {meetingId: meeting.id, summary: summaryData} : previous);
  }, [meeting.id, summaryData]);
  // Scope derived AI names to their meeting even before effects run on navigation.
  const aiSummary = state.meetingId === meeting.id ? state.summary : summaryData;
  return { transcripts: meeting.transcripts, speakers: meeting.speakers, aiSummary, setAiSummary };
}
