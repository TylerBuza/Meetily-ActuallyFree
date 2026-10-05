'use client';
import { useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Camera } from 'lucide-react';
import { toast } from 'sonner';
import { Hint } from '@/components/ui/tooltip';
import { Spinner } from '@/components/ui/spinner';
import { screenImage } from '@/lib/screen-image';
import { MEETING_IMAGES_CHANGED } from '@/lib/meeting-images';
import { formatClock } from '@/lib/dates';
export function RecordingScreenshotButton({ disabled, className }: { disabled?: boolean; className?: string }) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const capture = async () => {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    try {
      const blob = await screenImage();
      // Native active duration excludes pauses and shares the transcript clock.
      const state = await invoke<{ is_recording: boolean; active_duration?: number }>('get_recording_state');
      if (!state.is_recording || state.active_duration === undefined || !Number.isFinite(state.active_duration)) throw new Error('The recording has ended. Capture an image from the saved meeting instead.');
      const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()));
      await invoke('save_meeting_image', { live: true, audioTime: state.active_duration, bytes });
      window.dispatchEvent(new Event(MEETING_IMAGES_CHANGED));
      toast.success(`Image saved at ${formatClock(state.active_duration)}`);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'NotAllowedError')) toast.error(String(error));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <Hint label="Capture screenshot"><button type="button" aria-label="Capture screenshot" disabled={disabled || busy} className={className} onClick={() => void capture()}>{busy ? <Spinner size={14} /> : <Camera size={14} />}</button></Hint>;
}
