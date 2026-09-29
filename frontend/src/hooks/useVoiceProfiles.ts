'use client';

import { useEffect, useState } from 'react';
import { onWorkspaceChange } from '@/lib/workspace-api';
import { listVoiceProfiles, VOICE_PROFILES_CHANGED_EVENT, type VoiceProfile } from '@/lib/voice-profiles';

/**
 * The learned voices, kept current as voices are learned or forgotten and as
 * contacts are renamed, merged or deleted. Null until loaded; not loaded while
 * `enabled` is false.
 */
export function useVoiceProfiles(enabled = true): VoiceProfile[] | null {
  const [profiles, setProfiles] = useState<VoiceProfile[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setProfiles(null);
      return;
    }
    let cancelled = false;
    const load = () => {
      listVoiceProfiles()
        .then((next) => !cancelled && setProfiles(next))
        .catch(() => !cancelled && setProfiles([]));
    };
    load();
    window.addEventListener(VOICE_PROFILES_CHANGED_EVENT, load);
    const stop = onWorkspaceChange(['people'], load);
    return () => {
      cancelled = true;
      window.removeEventListener(VOICE_PROFILES_CHANGED_EVENT, load);
      stop();
    };
  }, [enabled]);

  return profiles;
}
