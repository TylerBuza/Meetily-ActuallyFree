'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { PostCallProcessingWorker } from '@/components/MeetingDetails/PostCallProcessingWorker';

export interface PostCallView {
  meetingId: string;
  meetingFolderPath?: string | null;
  enabled: boolean;
  onRefetchTranscripts?: () => Promise<void>;
  onComplete: () => void;
}

interface Jobs {
  attach: (view: PostCallView) => () => void;
}
const Context = createContext<Jobs | null>(null);
export const usePostCallJobs = () => useContext(Context);

/** Route changes detach views, not work. Only the mounted view may refresh its
 * state; completion is retained for the next visit. Native retranscription is
 * single-flight, so the host presents one handoff at a time. */
export function PostCallJobsProvider({ children }: { children: React.ReactNode }) {
  const views = useRef(new Map<string, PostCallView>());
  const completed = useRef(new Set<string>());
  const dirty = useRef(new Set<string>());
  const [queue, setQueue] = useState<PostCallView[]>([]);
  const attach = useCallback((view: PostCallView) => {
    views.current.set(view.meetingId, view);
    const isCompleted = completed.current.has(view.meetingId)
      || sessionStorage.getItem(`post-call-processing:${view.meetingId}`) === 'completed';
    if (isCompleted) {
      view.onComplete();
    } else if (view.enabled) {
      setQueue(current => current.some(job => job.meetingId === view.meetingId)
        ? current : [...current, view]);
    }
    if (dirty.current.delete(view.meetingId)) {
      void view.onRefetchTranscripts?.().catch(() => dirty.current.add(view.meetingId));
    }
    return () => {
      if (views.current.get(view.meetingId) === view) views.current.delete(view.meetingId);
    };
  }, []);
  const job = queue[0];
  return <Context.Provider value={{ attach }}>
    {children}
    {job && <PostCallProcessingWorker key={`post-call-job:${job.meetingId}`}
      enabled meetingId={job.meetingId} meetingFolderPath={job.meetingFolderPath}
      onRefetchTranscripts={async () => {
        const view = views.current.get(job.meetingId);
        if (view?.onRefetchTranscripts) await view.onRefetchTranscripts();
        else dirty.current.add(job.meetingId);
      }}
      onComplete={() => {
        completed.current.add(job.meetingId);
        views.current.get(job.meetingId)?.onComplete();
        setQueue(current => current.filter(candidate => candidate.meetingId !== job.meetingId));
      }} />}
  </Context.Provider>;
}
