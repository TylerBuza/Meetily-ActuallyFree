'use client';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useLabs } from '@/hooks/useLabs';
import { Button } from '@/components/ui/button';
interface Suggestion { person_id: string; name: string; score: number }
// Share a saved-speaker calculation between its popover and identity dialog.
// Only completed results are cached; errors remain retryable and no audio is stored.
const pending = new Map<string, Promise<Suggestion | null>>();
export function PossibleVoiceMatch({ speaker, meetingId, onAccept, disabled = false, review = false, inline = false, speakerChannel }: {
  speaker: string; meetingId?: string; onAccept: (name: string) => void; disabled?: boolean; review?: boolean; inline?: boolean; speakerChannel?: string;
}) {
  const { labs } = useLabs();
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setSuggestion(null); setError('');
    if (!labs.voiceProfiles || !/^Speaker \d+$/.test(speaker)) return;
    let disposed = false;
    let running = false;
    const load = async () => {
      if (running) return;
      running = true;
      const channel = meetingId ? speaker : speakerChannel ?? speaker;
      const key = `${meetingId}:${channel}`;
      try {
        let request = meetingId ? pending.get(key) : undefined;
        if (!request) {
          request = invoke<Suggestion | null>('get_possible_voice_match', { meetingId: meetingId ?? null, speaker: channel });
          if (meetingId) { pending.set(key, request); void request.finally(() => pending.delete(key)).catch(() => {}); }
        }
        const result = await request;
        if (!disposed) { setSuggestion(result); setError(''); }
      } catch { if (!disposed) setError('Voice suggestion unavailable.'); }
      finally { running = false; }
    };
    void load();
    const timer = meetingId ? undefined : window.setInterval(() => void load(), 3000);
    return () => { disposed = true; if (timer !== undefined) window.clearInterval(timer); };
  }, [speaker, speakerChannel, meetingId, labs.voiceProfiles]);
  if (error) return <p className="px-3 text-xs text-af-text-3">{error}</p>;
  if (!suggestion) return null;
  if (inline) return <span className="shrink-0 pt-2"><Button size="sm" variant="secondary" title={`Maybe ${suggestion.name}?`} aria-label={`Review match: maybe ${suggestion.name}`} disabled={disabled} onClick={() => onAccept(suggestion.name)}>Review match</Button><span className="mt-1 block max-w-32 truncate text-[11px] text-af-text-3">Maybe {suggestion.name}?</span></span>;
  return <div className="px-3 py-2 text-xs text-af-text-2">
    <span>Maybe {suggestion.name}?</span>{' '}
    <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onAccept(suggestion.name)}>{review ? 'Review match' : 'Match this person'}</Button>
  </div>;
}
