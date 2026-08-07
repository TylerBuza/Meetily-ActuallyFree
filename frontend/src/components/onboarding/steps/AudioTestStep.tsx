'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { OnboardingContainer } from '../OnboardingContainer';
import { Mic, Volume2 } from 'lucide-react';

/**
 * Quick mic + system-audio level check so users know capture works before
 * their first real meeting.
 */
export function AudioTestStep() {
  const { goNext, goPrevious, completeOnboarding } = useOnboarding();
  const [micRms, setMicRms] = useState(0);
  const [sysRms, setSysRms] = useState(0);
  const [micHeard, setMicHeard] = useState(false);
  const [sysHeard, setSysHeard] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const monitoring = useRef(false);

  const stop = useCallback(async () => {
    if (!monitoring.current) return;
    monitoring.current = false;
    try {
      await invoke('stop_audio_level_monitoring');
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        monitoring.current = true;
        await invoke('start_audio_level_monitoring');
        unlisten = await listen<{
          device_type?: string;
          source?: string;
          rms?: number;
          level?: number;
        }>('audio-levels', (event) => {
          const p = event.payload || {};
          const rms = typeof p.rms === 'number' ? p.rms : typeof p.level === 'number' ? p.level : 0;
          const kind = (p.device_type || p.source || '').toLowerCase();
          if (kind.includes('input') || kind.includes('mic')) {
            setMicRms(rms);
            if (rms > 0.02) setMicHeard(true);
          } else if (kind.includes('output') || kind.includes('system')) {
            setSysRms(rms);
            if (rms > 0.02) setSysHeard(true);
          }
        });
      } catch (e) {
        if (!cancelled) {
          setError(typeof e === 'string' ? e : 'Could not start level meters');
        }
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
      void stop();
    };
  }, [stop]);

  const finish = async () => {
    await stop();
    try {
      await completeOnboarding();
      await new Promise((r) => setTimeout(r, 100));
      window.location.reload();
    } catch (e) {
      console.error('Failed to complete onboarding:', e);
    }
  };

  const bar = (rms: number, ok: boolean) => (
    <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--af-panel-2)]">
      <div
        className={`h-full rounded-full transition-all ${ok ? 'bg-emerald-500' : 'bg-[var(--af-accent)]'}`}
        style={{ width: `${Math.min(100, Math.round(rms * 400))}%` }}
      />
    </div>
  );

  return (
    <OnboardingContainer
      title="Test your audio"
      description="Speak into the mic, and play something on your speakers. Levels should move."
      step={5}
      totalSteps={5}
      showNavigation
      onPrevious={async () => {
        await stop();
        goPrevious();
      }}
      onNext={finish}
      canGoNext
      canGoPrevious
    >
      <div className="mx-auto max-w-md space-y-5">
        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4 space-y-2">
          <div className="flex items-center justify-between text-sm font-medium text-[var(--af-text)]">
            <span className="inline-flex items-center gap-2">
              <Mic size={16} className="text-blue-400" /> Microphone
            </span>
            <span className={micHeard ? 'text-emerald-400 text-xs' : 'text-[var(--af-text-3)] text-xs'}>
              {micHeard ? 'Heard you ✓' : 'Speak now…'}
            </span>
          </div>
          {bar(micRms, micHeard)}
        </div>

        <div className="rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4 space-y-2">
          <div className="flex items-center justify-between text-sm font-medium text-[var(--af-text)]">
            <span className="inline-flex items-center gap-2">
              <Volume2 size={16} className="text-purple-400" /> System audio
            </span>
            <span className={sysHeard ? 'text-emerald-400 text-xs' : 'text-[var(--af-text-3)] text-xs'}>
              {sysHeard ? 'Detected ✓' : 'Play a video…'}
            </span>
          </div>
          {bar(sysRms, sysHeard)}
        </div>

        {error && <p className="text-center text-xs text-amber-400">{error}</p>}
        <p className="text-center text-xs text-[var(--af-text-3)]">
          You can finish even if a meter stays quiet — fix devices later in Settings → Recording.
        </p>
      </div>
    </OnboardingContainer>
  );
}

export default AudioTestStep;
