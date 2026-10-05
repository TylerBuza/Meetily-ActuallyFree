'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Avatar } from '@/components/ui/avatar';
import { useVoiceProfiles } from '@/hooks/useVoiceProfiles';
import { useLabs } from '@/hooks/useLabs';
import { describeVoiceError, describeVoiceSource, forgetVoice, queueVoiceLearning } from '@/lib/voice-profiles';
import { FeatureSettingsSwitch } from '@/components/FeatureSettingsSwitch';
/** The learned voices, each linked to its contact. */
function LearnedVoices() {
  const profiles = useVoiceProfiles();
  const { labs } = useLabs();
  const [busy, setBusy] = useState(false);
  const learn = async (personId?: string) => {
    setBusy(true);
    try {
      await queueVoiceLearning(personId);
      toast.success('Voice learning started', { description: 'Progress continues when you leave Settings.' });
    } catch (error) { setBusy(false); toast.error('Could not start voice learning', { description: describeVoiceError(error) }); }

  };
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);

  useEffect(() => {
    let disposed = false;
    let observed = false;
    let stop: (() => void) | undefined;
    void listen<{ status: string }>('voice-profile-learning-result', ({ payload }) => {
      observed = true;
      if (!disposed) setBusy(payload.status !== 'complete');
    }).then(unlisten => {
      if (disposed) { unlisten(); return; }
      stop = unlisten;
      void invoke<boolean>('get_voice_profile_learning_busy').then(value => { if (!disposed && !observed) setBusy(value); }).catch(console.error);
    }).catch(console.error);
    return () => { disposed = true; stop?.(); };
  }, []);

  useEffect(() => {
    invoke<{ pyannote_available?: boolean }>('diarization_get_status')
      .then((status) => setModelsReady(!!status.pyannote_available))
      .catch(() => setModelsReady(null));
  }, []);

  return (
    <div className="space-y-2">
      <p className="text-xs text-af-text-3">Learn up to 12 clear speech samples per meeting across 12 recent meetings (144 maximum). Refreshing replaces repeated audio instead of counting it twice.</p>
      <Button size="sm" variant="secondary" disabled={busy || !labs.voiceProfiles || modelsReady !== true || !profiles?.length} onClick={() => void learn()}>Learn all profiles</Button>
      {modelsReady === false && (
        <p className="rounded-lg border border-af-warning/30 bg-af-warning/[0.08] px-3 py-2 text-xs text-af-text-2">
          Voice profiles need the speaker models.{' '}
          <Link href="/settings?section=transcription" className="font-medium text-af-accent hover:underline">
            Download them in Transcription
          </Link>
          .
        </p>
      )}
      {profiles === null ? (
        <div className="af-skeleton h-10 rounded-lg" />
      ) : profiles.length === 0 ? (
        <p className="text-xs leading-relaxed text-af-text-3">
          No voices yet. Open a contact from{' '}
          <Link href="/contacts" className="font-medium text-af-accent hover:underline">
            Contacts
          </Link>{' '}
          and choose Learn voice.
        </p>
      ) : (
        <ul className="divide-y divide-af-border overflow-hidden rounded-xl border border-af-border bg-af-panel">
          {profiles.map((profile) => (
            <li key={profile.person_id} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <Avatar name={profile.name} size="sm" />
              <Link
                href={`/person?id=${encodeURIComponent(profile.person_id)}`}
                className="min-w-0 flex-1 truncate text-[13px] font-medium text-af-text hover:text-af-accent"
              >
                {profile.name}
              </Link>
              <span className="shrink-0 text-[11px] tabular-nums text-af-text-4">
                {describeVoiceSource(profile)}
              </span>
              <Button size="sm" variant="secondary" disabled={busy || !labs.voiceProfiles || modelsReady !== true} onClick={() => void learn(profile.person_id)}>Learn more turns</Button>
              <button
                disabled={busy}
                type="button"
                aria-label={`Forget ${profile.name}'s voice`}
                onClick={() =>
                  forgetVoice(profile.person_id)
                    .then(() => toast.success(`Forgot ${profile.name}'s voice`))
                    .catch((error) => toast.error('Could not forget the voice', { description: describeVoiceError(error) }))
                }
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-af-text-4 transition-colors hover:bg-af-danger/10 hover:text-af-danger"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}


export function VoiceProfilesSettings() {
  return <div className="space-y-5">
    <FeatureSettingsSwitch feature="voiceProfiles" title="Recognize saved voices" description="Learn named contacts from clear recorded call audio, then suggest their names when speakers are identified." />
    <FeatureSettingsSwitch feature="autoSaveVoiceProfiles" title="Automatically save newly named voices" description="Save the first profile after you name a speaker. Requires saved call audio and speaker models; existing profiles are kept." />
    <FeatureSettingsSwitch feature="voiceConsensus" title="Consensus voice matching (experimental)" description="Compare against separate meeting samples and require agreement across at least two meetings. This can reduce uncertain matches but may leave more speakers unnamed. Off by default; learn from two meetings before enabling." />
    <section className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5"><h3 className="mb-3 text-sm font-semibold">Saved voices</h3><LearnedVoices /></section>
  </div>;
}
