'use client';

import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Analytics from '@/lib/analytics';
import { AUTO_START_KEY } from '@/lib/recording-launch';
import { invoke } from '@tauri-apps/api/core';
import { useRecordingState } from '@/contexts/RecordingStateContext';
import { displayedSidebarWidth, previewSidebarWidth, SIDEBAR_DEFAULT, SIDEBAR_MIN, snapSidebarWidth, windowWidthForRail } from '@/hooks/useCompactChrome';
import { onWorkspaceChange } from '@/lib/workspace-api';


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
  group_id?: string | null;
  summary_preview?: string | null;
  summary_data?: string | null;
  named_participants?: string[];
}

interface SidebarContextType {
  currentMeeting: CurrentMeeting | null;
  setCurrentMeeting: (meeting: CurrentMeeting | null) => void;
  sidebarItems: SidebarItem[];
  isCollapsed: boolean;
  sidebarWidth: number;
  setSidebarWidth: (width: number, origin?: number) => void;
  toggleRail: () => void;
  previewSidebar: (width: number) => void;
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
  stopSummaryPolling: (meetingId: string, processId?: string) => void;
  // Refetch meetings from backend
  refetchMeetings: () => Promise<void>;

}

const SidebarContext = createContext<SidebarContextType | null>(null);

async function growWindowWidth(width: number) {
  try {
    const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    const factor = await win.scaleFactor();
    const size = (await win.innerSize()).toLogical(factor);
    if (size.width >= width) return;
    await win.setSize(new LogicalSize(width, size.height));
  } catch {
    // Browser preview, or the desktop window is not available yet.
  }
}

export const useSidebar = () => {
  const context = useContext(SidebarContext);
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider');
  }
  return context;
};

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [currentMeeting, setCurrentMeeting] = useState<CurrentMeeting | null>({ id: 'intro-call', title: '+ New Call' });
  const [preferredWidth, setPreferredWidth] = useState(SIDEBAR_DEFAULT);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const lastOpenWidthRef = useRef(SIDEBAR_DEFAULT);
  const [windowWidth, setWindowWidth] = useState(1600);
  const sidebarWidth = dragWidth ?? displayedSidebarWidth(preferredWidth, windowWidth);
  const isCollapsed = sidebarWidth <= SIDEBAR_MIN + 8;
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
  const summaryPollGenerationRef = useRef<Map<string, number>>(new Map());
  const summaryPollOwnersRef = useRef<Map<string, string>>(new Map());
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
          group_id?: string | null;
          summary_preview?: string | null;
          summary_data?: string | null;
          named_participants?: string[];
        }>;
        const transformedMeetings = meetings.map((meeting) => ({
          id: meeting.id,
          title: meeting.title,
          created_at: meeting.created_at ?? (meeting as any).createdAt ?? (meeting as any).updated_at,
          duration_seconds: meeting.duration_seconds,
          group_id: meeting.group_id ?? null,
          summary_preview: meeting.summary_preview ?? null,
          summary_data: meeting.summary_data ?? null,
          named_participants: meeting.named_participants ?? [],
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

  // Renames, group moves and deletes made anywhere refresh the list.
  useEffect(() => onWorkspaceChange(['meetings'], () => void fetchMeetings()), [fetchMeetings]);

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


  const setSidebarWidth = (width: number, origin?: number) => {
    setDragWidth(null);
    setPreferredWidth(snapSidebarWidth(width, windowWidth, origin));
  };

  const previewSidebar = (width: number) => {
    setDragWidth(previewSidebarWidth(width, windowWidth));
  };

  const toggleRail = useCallback(() => {
    setDragWidth(null);
    if (sidebarWidth <= SIDEBAR_MIN + 8) {
      const restore = Math.max(SIDEBAR_DEFAULT, lastOpenWidthRef.current);
      const needed = windowWidthForRail(restore);
      if (windowWidth < needed) {
        setWindowWidth(needed);
        void growWindowWidth(needed);
      }
      setPreferredWidth(snapSidebarWidth(restore, Math.max(windowWidth, needed), SIDEBAR_MIN));
      return;
    }
    lastOpenWidthRef.current = Math.max(SIDEBAR_DEFAULT, sidebarWidth);
    setPreferredWidth(SIDEBAR_MIN);
  }, [sidebarWidth, windowWidth]);

  useEffect(() => {
    const read = () => setWindowWidth(window.innerWidth);
    read();
    window.addEventListener('resize', read);
    return () => window.removeEventListener('resize', read);
  }, []);

  useEffect(() => {
    if (dragWidth == null && sidebarWidth >= SIDEBAR_DEFAULT) {
      lastOpenWidthRef.current = sidebarWidth;
    }
  }, [dragWidth, sidebarWidth]);

  useEffect(() => {
    document.documentElement.style.setProperty('--af-sidebar-width', `${sidebarWidth}px`);
    window.dispatchEvent(new Event('af-sidebar-width'));
    return () => {
      document.documentElement.style.removeProperty('--af-sidebar-width');
    };
  }, [sidebarWidth]);

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
      sessionStorage.removeItem(AUTO_START_KEY);
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
    summaryPollOwnersRef.current.delete(meetingId);
    summaryPollGenerationRef.current.set(
      meetingId,
      (summaryPollGenerationRef.current.get(meetingId) ?? 0) + 1
    );
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
    summaryPollOwnersRef.current.set(meetingId, processId);
    const pollGeneration = summaryPollGenerationRef.current.get(meetingId) ?? 0;
    const isCurrentPoll = () =>
      summaryPollGenerationRef.current.get(meetingId) === pollGeneration;

    console.log(`📊 Starting polling for meeting ${meetingId}, process ${processId}`);

    let pollCount = 0;
    const MAX_POLLS = 200; // ~16.5 minutes at 5-second intervals
    let stopped = false;
    let inFlight = false;

    const tick = async () => {
      if (stopped || inFlight || !isCurrentPoll()) return;
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

      inFlight = true;
      try {
        const result = await invoke('api_get_summary', {
          meetingId: meetingId,
        }) as any;

        if (stopped || !isCurrentPoll()) return;
        console.log(`📊 Polling update for ${meetingId}:`, result.status);

        onUpdate(result);
        if (!isCurrentPoll()) return;

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
        if (stopped || !isCurrentPoll()) return;
        console.error(`Polling error for ${meetingId}:`, error);
        onUpdate({
          status: 'error',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
        stopped = true;
        clearPoll(meetingId);
      } finally {
        inFlight = false;
      }
    };

    // Poll immediately so the UI doesn't sit idle for 5s, then every 5s.
    void tick();
    const pollInterval = setInterval(() => { void tick(); }, 5000);
    activeSummaryPollsRef.current.set(meetingId, pollInterval);
    setActiveSummaryPolls(new Map(activeSummaryPollsRef.current));
  }, [clearPoll]);

  const stopSummaryPolling = useCallback((meetingId: string, processId?: string) => {
    if (processId && summaryPollOwnersRef.current.get(meetingId) !== processId) return;
    if (activeSummaryPollsRef.current.has(meetingId)) {
      console.log(`⏹️ Stopping polling for meeting ${meetingId}`);
      clearPoll(meetingId);
    }
  }, [clearPoll]);

  // Cleanup all polling intervals on unmount
  useEffect(() => {
    return () => {
      console.log('🧹 Cleaning up all summary polling intervals');
      for (const [meetingId, interval] of activeSummaryPollsRef.current) {
        clearInterval(interval);
        summaryPollGenerationRef.current.set(meetingId, (summaryPollGenerationRef.current.get(meetingId) ?? 0) + 1);
      }
      activeSummaryPollsRef.current.clear();
      summaryPollOwnersRef.current.clear();
    };
  }, []);



  return (
    <SidebarContext.Provider value={{
      currentMeeting,
      setCurrentMeeting,
      sidebarItems,
      isCollapsed,
      sidebarWidth,
      setSidebarWidth,
      toggleRail,
      previewSidebar,
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
