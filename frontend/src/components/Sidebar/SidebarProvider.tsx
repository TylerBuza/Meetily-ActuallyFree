'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Analytics from '@/lib/analytics';
import { invoke } from '@tauri-apps/api/core';
import { useRecordingState } from '@/contexts/RecordingStateContext';


interface SidebarItem {
  id: string;
  title: string;
  type: 'folder' | 'file';
  children?: SidebarItem[];
  createdAt?: string;
  durationSeconds?: number;
}

export interface CurrentMeeting {
  id: string;
  title: string;
  created_at?: string;
  /** Approx length in seconds (from transcript timings). */
  duration_seconds?: number;
}

interface SidebarContextType {
  currentMeeting: CurrentMeeting | null;
  setCurrentMeeting: (meeting: CurrentMeeting | null) => void;
  sidebarItems: SidebarItem[];
  isCollapsed: boolean;
  toggleCollapse: () => void;
  meetings: CurrentMeeting[];
  setMeetings: (meetings: CurrentMeeting[]) => void;
  isMeetingActive: boolean;
  setIsMeetingActive: (active: boolean) => void;
  handleRecordingToggle: () => void;
  setServerAddress: (address: string) => void;
  serverAddress: string;
  transcriptServerAddress: string;
  setTranscriptServerAddress: (address: string) => void;
  // Summary polling management
  activeSummaryPolls: Map<string, NodeJS.Timeout>;
  startSummaryPolling: (meetingId: string, processId: string, onUpdate: (result: any) => void) => void;
  stopSummaryPolling: (meetingId: string) => void;
  // Refetch meetings from backend
  refetchMeetings: () => Promise<void>;

}

const SidebarContext = createContext<SidebarContextType | null>(null);

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [currentMeeting, setCurrentMeeting] = useState<CurrentMeeting | null>({ id: 'intro-call', title: '+ New Call' });
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [meetings, setMeetings] = useState<CurrentMeeting[]>([]);
  const [sidebarItems, setSidebarItems] = useState<SidebarItem[]>([]);
  const [isMeetingActive, setIsMeetingActive] = useState(false);
  const [serverAddress, setServerAddress] = useState('');
  const [transcriptServerAddress, setTranscriptServerAddress] = useState('');
  // Interval handles live in a ref so start/stop stay identity-stable.
  // Putting them in useState recreated the callbacks on every poll start, which
  // re-ran page-level effect cleanups and immediately killed the brand-new poll
  // — auto-summary finished on the backend but the UI never received it.
  const activeSummaryPollsRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const [activeSummaryPolls, setActiveSummaryPolls] = useState<Map<string, NodeJS.Timeout>>(new Map());

  // Use recording state from RecordingStateContext (single source of truth)
  const { isRecording } = useRecordingState();

  const pathname = usePathname();
  const router = useRouter();

  // Extract fetchMeetings as a reusable function
  const fetchMeetings = React.useCallback(async () => {
    if (serverAddress) {
      try {
        const meetings = await invoke('api_get_meetings') as Array<{
          id: string;
          title: string;
          created_at?: string;
          duration_seconds?: number;
        }>;
        const transformedMeetings = meetings.map((meeting) => ({
          id: meeting.id,
          title: meeting.title,
          created_at: meeting.created_at ?? (meeting as any).createdAt ?? (meeting as any).updated_at,
          duration_seconds: meeting.duration_seconds,
        }));
        setMeetings(transformedMeetings);
        Analytics.trackBackendConnection(true);
      } catch (error) {
        console.error('Error fetching meetings:', error);
        setMeetings([]);
        Analytics.trackBackendConnection(false, error instanceof Error ? error.message : 'Unknown error');
      }
    }
  }, [serverAddress]);

  useEffect(() => {
    fetchMeetings();
  }, [serverAddress, fetchMeetings]);

  useEffect(() => {
    const fetchSettings = async () => {
      setServerAddress('http://localhost:5167');
      setTranscriptServerAddress('http://127.0.0.1:8178/stream');
    };
    fetchSettings();
  }, []);

  const baseItems: SidebarItem[] = [
    {
      id: 'meetings',
      title: 'Recent Meetings',
      type: 'folder' as const,
      children: [
        ...meetings.map(meeting => ({
          id: meeting.id,
          title: meeting.title,
          type: 'file' as const,
          createdAt: meeting.created_at,
          durationSeconds: meeting.duration_seconds,
        }))
      ]
    },
  ];


  const toggleCollapse = () => {
    setIsCollapsed(!isCollapsed);
  };

  // Update current meeting when on home page
  useEffect(() => {
    if (pathname === '/') {
      setCurrentMeeting({ id: 'intro-call', title: '+ New Call' });
    }
    setSidebarItems(baseItems);
  }, [pathname]);

  // Update sidebar items when meetings change
  useEffect(() => {
    setSidebarItems(baseItems);
  }, [meetings]);

  // "New Recording" only opens the home/ready screen. The user must still tap
  // the red mic button to actually start capture — auto-start was surprising.
  // (Meeting-detection toasts still fire start-recording-from-sidebar separately.)
  const handleRecordingToggle = () => {
    if (isRecording) return;

    // Clear any leftover auto-start flag from older builds / detection paths.
    try {
      sessionStorage.removeItem('autoStartRecording');
    } catch {
      /* ignore */
    }

    if (pathname !== '/') {
      router.push('/');
    }
    Analytics.trackButtonClick('new_recording_ready', 'sidebar');
  };

  // Summary polling management
  const clearPoll = useCallback((meetingId: string) => {
    const existing = activeSummaryPollsRef.current.get(meetingId);
    if (existing) {
      clearInterval(existing);
      activeSummaryPollsRef.current.delete(meetingId);
      setActiveSummaryPolls(new Map(activeSummaryPollsRef.current));
    }
  }, []);

  const startSummaryPolling = useCallback((
    meetingId: string,
    processId: string,
    onUpdate: (result: any) => void
  ) => {
    // Stop existing poll for this meeting if any
    clearPoll(meetingId);

    console.log(`📊 Starting polling for meeting ${meetingId}, process ${processId}`);

    let pollCount = 0;
    const MAX_POLLS = 200; // ~16.5 minutes at 5-second intervals
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      pollCount++;

      if (pollCount >= MAX_POLLS) {
        console.warn(`⏱️ Polling timeout for ${meetingId} after ${MAX_POLLS} iterations`);
        stopped = true;
        clearPoll(meetingId);
        onUpdate({
          status: 'error',
          error: 'Summary generation timed out after 15 minutes. Please try again or check your model configuration.'
        });
        return;
      }

      try {
        const result = await invoke('api_get_summary', {
          meetingId: meetingId,
        }) as any;

        if (stopped) return;
        console.log(`📊 Polling update for ${meetingId}:`, result.status);

        onUpdate(result);

        const status = (result.status || '').toLowerCase();
        const terminal =
          status === 'completed' ||
          status === 'error' ||
          status === 'failed' ||
          status === 'cancelled' ||
          // Backend may flip to idle once the row is gone; if data is present
          // treat it as done so the UI still picks up the summary.
          (status === 'idle' && !!result.data) ||
          (status === 'idle' && pollCount > 3);

        if (terminal) {
          console.log(`Polling completed for ${meetingId}, status: ${result.status}`);
          stopped = true;
          clearPoll(meetingId);
        }
      } catch (error) {
        if (stopped) return;
        console.error(`Polling error for ${meetingId}:`, error);
        onUpdate({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        stopped = true;
        clearPoll(meetingId);
      }
    };

    // Poll immediately so the UI doesn't sit idle for 5s, then every 5s.
    void tick();
    const pollInterval = setInterval(() => { void tick(); }, 5000);
    activeSummaryPollsRef.current.set(meetingId, pollInterval);
    setActiveSummaryPolls(new Map(activeSummaryPollsRef.current));
  }, [clearPoll]);

  const stopSummaryPolling = useCallback((meetingId: string) => {
    if (activeSummaryPollsRef.current.has(meetingId)) {
      console.log(`⏹️ Stopping polling for meeting ${meetingId}`);
      clearPoll(meetingId);
    }
  }, [clearPoll]);

  // Cleanup all polling intervals on unmount
  useEffect(() => {
    return () => {
      console.log('🧹 Cleaning up all summary polling intervals');
      activeSummaryPolls.forEach(interval => clearInterval(interval));
    };
  }, [activeSummaryPolls]);



  return (
    <SidebarContext.Provider value={{
      currentMeeting,
      setCurrentMeeting,
      sidebarItems,
      isCollapsed,
      toggleCollapse,
      meetings,
      setMeetings,
      isMeetingActive,
      setIsMeetingActive,
      handleRecordingToggle,
      setServerAddress,
      serverAddress,
      transcriptServerAddress,
      setTranscriptServerAddress,
      activeSummaryPolls,
      startSummaryPolling,
      stopSummaryPolling,
      refetchMeetings: fetchMeetings,

    }}>
      {children}
    </SidebarContext.Provider>
  );
}
