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
  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<{ name?: string; personId?: string; status: string; error?: string; samples?: number; meetings?: number; saved?: number; failed?: number }>('voice-profile-learning-result', ({ payload }) => {
      if (disposed) return;
      const id = payload.personId ? `voice-learn-${payload.personId}` : 'voice-learn-all';
      if (payload.status === 'learning') toast.loading(`Learning more turns for ${payload.name}`, { id });
      else if (payload.status === 'failed') toast.error(`Could not learn ${payload.name}'s voice`, { id, description: payload.error });
      else if (payload.status === 'saved') {
        window.dispatchEvent(new Event(VOICE_PROFILES_CHANGED_EVENT));
        toast.success(`Voice refreshed for ${payload.name}`, { id, description: `${payload.samples} clear samples across ${payload.meetings} meetings. Repeated audio is counted once.` });
      } else if (payload.status === 'complete') {
        const notify = payload.failed ? toast.error : toast.success;
        notify('Voice learning finished', { id, description: `${payload.saved} refreshed, ${payload.failed} could not be learned.` });
      }
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; }).catch(console.error);
    return () => { disposed = true; stop?.(); };
  }, []);
  return null;
}
