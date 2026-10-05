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
function VoiceMatchThreshold() {
  const [saved, setSaved] = useState<number | null>(null);
  const [value, setValue] = useState('0.55');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    void invoke<number>('get_voice_profiles_match_threshold').then(score => {
      if (!disposed) { setSaved(score); setValue(score.toFixed(2)); }
    }).catch(reason => { if (!disposed) setError(describeVoiceError(reason)); });
    return () => { disposed = true; };
  }, []);
  const score = Number(value);
  const valid = value.trim() !== '' && Number.isFinite(score) && score >= 0.35 && score <= 0.95;
  const save = async () => {
    if (!valid || busy || saved === null) return;
    setBusy(true); setError('');
    try { await invoke('set_voice_profiles_match_threshold', { value: score }); setSaved(score); }
    catch (reason) { setError(describeVoiceError(reason)); }
    finally { setBusy(false); }
  };
  return <section className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
    <label htmlFor="voice-match-score" className="text-sm font-semibold">Voice matching score threshold</label>
    <p className="my-2 text-xs text-af-text-3">Higher scores make matching stricter. Lower scores may confuse similar voices. Default: 0.55. Repeated clear speech and a margin over other profiles are still required.</p>
    <div className="flex items-center gap-3">
      <input aria-label="Voice matching score slider" type="range" min="0.35" max="0.95" step="0.01" disabled={saved === null || busy} value={valid ? score : saved ?? 0.55} onChange={event => setValue(event.target.value)} className="min-w-0 flex-1" />
      <input id="voice-match-score" type="number" min="0.35" max="0.95" step="0.01" disabled={saved === null || busy} value={value} onChange={event => setValue(event.target.value)} className="w-20 rounded border border-af-border bg-af-panel px-2 py-1" />
      <Button size="sm" disabled={!valid || saved === null || score === saved || busy} onClick={() => void save()}>Save score</Button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-af-danger">{error}</p>}
  </section>;
}

function AutomaticSampleLimit() {
  const [value, setValue] = useState('12');
  const [saved, setSaved] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    let disposed = false;
    void invoke<number>('get_voice_profiles_auto_samples').then(limit => { if (!disposed) { setSaved(limit); setValue(String(limit)); } }).catch(reason => { if (!disposed) setError(describeVoiceError(reason)); });
    return () => { disposed = true; };
  }, []);
  const limit = Number(value);
  const valid = Number.isInteger(limit) && limit >= 2 && limit <= 12;
  const save = async () => {
    if (!valid || busy || saved === null) return;
    setBusy(true); setError('');
    try { await invoke('set_voice_profiles_auto_samples', { value: limit }); setSaved(limit); }
    catch (reason) { setError(describeVoiceError(reason)); }
    finally { setBusy(false); }
  };
  return <div className="flex flex-wrap items-center gap-3 px-5 text-xs text-af-text-2">
    <label htmlFor="automatic-voice-samples">Automatic samples per meeting</label>
    <input id="automatic-voice-samples" type="number" min="2" max="12" step="1" disabled={saved === null || busy} value={value} onChange={event => setValue(event.target.value)} className="w-16 rounded border border-af-border bg-af-panel px-2 py-1" />
    <Button size="sm" disabled={!valid || saved === null || saved === limit || busy} onClick={() => void save()}>Save limit</Button>
    {error && <p role="alert" className="text-af-danger">{error}</p>}
  </div>;
}

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
    <FeatureSettingsSwitch feature="autoSaveVoiceProfiles" title="Automatically save and update clear speech samples" description="Learn named voices and refresh existing profiles from saved call audio, up to the sample limit below across 12 recent meetings. Repeated meetings replace their samples; unclear updates keep the existing voice." />
    <AutomaticSampleLimit />
    <FeatureSettingsSwitch feature="voiceConsensus" title="Consensus voice matching (experimental)" description="Use separate meeting samples when available, with repeated clear-speech confirmation. Single-meeting profiles can also match. This may leave uncertain speakers unnamed. Off by default." />
    <VoiceMatchThreshold />
    <section className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5"><h3 className="mb-3 text-sm font-semibold">Saved voices</h3><LearnedVoices /></section>
  </div>;
}
