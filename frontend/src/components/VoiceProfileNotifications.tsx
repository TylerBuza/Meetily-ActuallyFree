'use client';
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { VOICE_PROFILES_CHANGED_EVENT } from '@/lib/voice-profiles';
export function VoiceProfileNotifications() {
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{ name?: string; error?: string }>('voice-profile-auto-save-result', ({ payload }) => {
      if (disposed) return;
      if (payload.error) toast.error('Could not save voice automatically', { description: payload.error });
      else {
        window.dispatchEvent(new Event(VOICE_PROFILES_CHANGED_EVENT));
        toast.success(`Voice saved for ${payload.name}`);
      }
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(console.error);
    return () => { disposed = true; stop?.(); };
  }, []);
  return null;
}
