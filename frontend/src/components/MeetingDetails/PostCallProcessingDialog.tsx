'use client';

import { useEffect, useRef } from 'react';
import { usePostCallJobs, type PostCallView } from '@/contexts/PostCallJobsContext';
import { PostCallProcessingWorker } from './PostCallProcessingWorker';

/** Registers the page as a view onto the app-owned post-call job. */
export function PostCallProcessingDialog(props: PostCallView) {
  const jobs = usePostCallJobs();
  const latest = useRef(props);
  latest.current = props;
  const attach = jobs?.attach;
  useEffect(() => attach?.({
    meetingId: props.meetingId,
    meetingFolderPath: props.meetingFolderPath,
    enabled: props.enabled,
    onComplete: () => { if (latest.current.meetingId === props.meetingId) latest.current.onComplete(); },
    onRefetchTranscripts: () => latest.current.meetingId === props.meetingId
      ? latest.current.onRefetchTranscripts?.() ?? Promise.resolve() : Promise.resolve(),
  }), [attach, props.meetingId, props.meetingFolderPath, props.enabled]);
  // Standalone embeddings/tests retain the same component contract.
  return jobs ? null : <PostCallProcessingWorker {...props} />;
}
