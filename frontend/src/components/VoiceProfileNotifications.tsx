'use client';
import { useEffect } from 'react';
import { listen } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { VOICE_PROFILES_CHANGED_EVENT } from '@/lib/voice-profiles';
export function VoiceProfileNotifications() {
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{ name?: string; personId?: string; status?: string; error?: string }>('voice-profile-auto-save-result', ({ payload }) => {
      if (disposed) return;
      const id = payload.personId ? `voice-auto-${payload.personId}` : undefined;
      if (payload.status === 'learning') {
        toast.loading(`Learning voice for ${payload.name}`, { id, description: 'Saving the first voice profile from the meeting audio.' });
        return;
      }
      if (payload.error) toast.error('Could not save voice automatically', { id, description: payload.error });
      else {
        window.dispatchEvent(new Event(VOICE_PROFILES_CHANGED_EVENT));
        toast.success(`Voice saved for ${payload.name}`, { id });
      }
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch(console.error);
    return () => { disposed = true; stop?.(); };
  }, []);
  return null;
}
