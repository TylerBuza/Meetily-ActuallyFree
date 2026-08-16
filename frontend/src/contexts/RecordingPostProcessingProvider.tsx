'use client';

import React, { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { useRecordingStop } from '@/hooks/useRecordingStop';
import { toast } from 'sonner';

/**
 * RecordingPostProcessingProvider
 *
 * This provider handles post-processing when recording stops from any source:
 * - Tray menu stop
 * - Global keyboard shortcut
 * - Overlay stop button
 * - Main UI stop button
 *
 * It listens for the 'recording-stop-complete' event from Rust backend
 * and triggers the full post-processing flow (save to database, navigate, analytics)
 * regardless of which page the user is currently on.
 */
export function RecordingPostProcessingProvider({ children }: { children: React.ReactNode }) {
  // No-op functions since the global RecordingStateContext already handles state updates
  // These are only needed for the hook's local component state management
  const setIsRecording = () => { };
  const setIsRecordingDisabled = () => { };

  const {
    handleRecordingStop,
  } = useRecordingStop(setIsRecording, setIsRecordingDisabled);
  const handleRecordingStopRef = useRef(handleRecordingStop);

  // Keep the native listener mounted for the provider's full lifetime. The stop
  // handler closes over live recording state and can change every render, but a
  // one-shot Tauri event must never fall into an unsubscribe/resubscribe gap.
  useEffect(() => {
    handleRecordingStopRef.current = handleRecordingStop;
  });

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let disposed = false;

    const setupListener = async () => {
      try {
        // Listen for recording-stop-complete event from Rust
        const unlisten = await listen<{
          call_api: boolean;
          folder_path?: string | null;
          meeting_name?: string | null;
          audio_save_error?: string | null;
        }>('recording-stop-complete', (event) => {
          console.log('[RecordingPostProcessing] Received recording-stop-complete event:', event.payload);

          const { call_api, folder_path, meeting_name, audio_save_error } = event.payload;
          if (audio_save_error) {
            toast.error('Some or all meeting audio could not be saved. The transcript will still be kept.', {
              description: audio_save_error,
              duration: 10000,
            });
          }
          if (folder_path) {
            sessionStorage.setItem('last_recording_folder_path', folder_path);
          } else {
            sessionStorage.removeItem('last_recording_folder_path');
          }
          if (meeting_name) {
            sessionStorage.setItem('last_recording_meeting_name', meeting_name);
          } else {
            sessionStorage.removeItem('last_recording_meeting_name');
          }
          void handleRecordingStopRef.current(call_api);
        });

        // StrictMode can clean up an effect before the asynchronous registration
        // resolves. Dispose that late listener rather than leaking a duplicate.
        if (disposed) {
          unlisten();
          return;
        }
        unlistenFn = unlisten;

        console.log('[RecordingPostProcessing] Event listener set up successfully');
      } catch (error) {
        console.error('[RecordingPostProcessing] Failed to set up event listener:', error);
      }
    };

    setupListener();

    return () => {
      disposed = true;
      if (unlistenFn) {
        console.log('[RecordingPostProcessing] Cleaning up event listener');
        unlistenFn();
      }
    };
  }, []);

  useEffect(() => {
    let unlistenFn: (() => void) | undefined;
    let disposed = false;

    void listen<string>('recording-error', (event) => {
      toast.error(event.payload || 'Recording stopped because audio capture failed.', {
        duration: 10000,
      });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
      } else {
        unlistenFn = unlisten;
      }
    }).catch((error) => {
      console.error('[RecordingPostProcessing] Failed to listen for recording errors:', error);
    });

    return () => {
      disposed = true;
      unlistenFn?.();
    };
  }, []);

  return <>{children}</>;
}
