'use client';

/**
 * Settings > Labs: experimental features, each off until it is turned on.
 * Every feature says where it shows up once on, since most of them live in
 * other screens (the meeting player, a contact's page, the record flow).
 */
import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { invoke } from '@tauri-apps/api/core';
import { AudioWaveform, Eraser, Fingerprint, Gauge, VolumeX, Workflow, X, type LucideIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Switch } from '@/components/ui/switch';
import { Avatar } from '@/components/ui/avatar';
import { Spinner } from '@/components/ui/spinner';
import { usePlatform } from '@/hooks/usePlatform';
import { useLabs } from '@/hooks/useLabs';
import { useVoiceProfiles } from '@/hooks/useVoiceProfiles';
import { setLabsFeature, syncLabsFromBackend, type LabsFeature } from '@/lib/labs-features';
import { describeVoiceError, describeVoiceSource, forgetVoice } from '@/lib/voice-profiles';

interface Feature {
  key: LabsFeature;
  icon: LucideIcon;
  title: string;
  description: string;
  /** Where it shows up or applies once on. */
  where: string;
  windowsOnly?: boolean;
}

const GROUPS: Array<{ title: string; features: Feature[] }> = [
  {
    title: 'Meetings',
    features: [
      {
        key: 'meetingAutomation',
        icon: Workflow,
        title: 'Meeting automation',
        description:
          'Start recording when meeting detection sees a call using your microphone or camera, and stop and save it when the call ends. Recordings you start yourself are never stopped.',
        where: 'Turns on meeting detection. A notice says when a call starts or ends a recording.',
      },
    ],
  },
  {
    title: 'Playback and transcript',
    features: [
      {
        key: 'transcriptScrubbing',
        icon: AudioWaveform,
        title: 'Waveform scrubbing',
        description:
          "Show the recording's waveform in the meeting player, so you can see where people talk and jump straight there. Adds 0.5× and 0.75× speeds.",
        where: "In the player under a meeting's transcript.",
      },
      {
        key: 'cleanTranscript',
        icon: Eraser,
        title: 'Clean transcript',
        description:
          'Hide hesitations and stutters ("um", "we we") in the transcript, and write new summaries from the clean text. The saved transcript stays word for word.',
        where: 'Switch between Clean and Verbatim in the meeting player.',
      },
    ],
  },
  {
    title: 'Speech recognition',
    features: [
      {
        key: 'whisperSilenceGuard',
        icon: VolumeX,
        title: 'Whisper silence guard',
        description:
          'Filter silence and background noise more strictly when Whisper transcribes, so quiet stretches do not turn into made-up lines. Very quiet speech may be skipped.',
        where: 'Applies whenever Whisper transcribes.',
      },
      {
        key: 'nearLiveCaptions',
        icon: AudioWaveform,
        title: 'Near-live captions',
        description: 'Show provisional Parakeet words during speech. Brief extra speakers or inaccurate words may appear; final transcription and diarization replace previews, and post-call processing can improve the saved result.',
        where: 'Applies to the next live recording. Parakeet provides provisional captions.',
      },
      {
        key: 'micPlaybackSuppression',
        icon: VolumeX,
        title: 'Suppress speaker playback on mic',
        description: 'Compare microphone and system audio and remove duplicate mic transcript turns. Short echoes may remain, and mixed local and remote speech can lose words.',
        where: 'Needs both capture sources. Audio filtering starts next recording; rerun post-call transcription to clean an older meeting.',
      },
      {
        key: 'parakeetGpu',
        icon: Gauge,
        title: 'Parakeet on the GPU',
        description:
          "Run Parakeet's encoder on your graphics card through DirectML. Switching reloads the model; if the GPU cannot load it, Parakeet stays on the CPU.",
        where: 'Applies to Parakeet transcription.',
        windowsOnly: true,
      },
    ],
  },
  {
    title: 'Voices',
    features: [
      {
        key: 'voiceProfiles',
        icon: Fingerprint,
        title: 'Voice profiles',
        description:
          "Learn a contact's voice from the meetings they spoke in. When speakers are identified in later meetings, a matching voice gets their name.",
        where: "Learn, update or forget a voice on a contact's page, or add one meeting's audio from its speaker card.",
      },
    ],
  },
];

function FeatureRow({
  feature,
  checked,
  busy,
  onChange,
  children,
}: {
  feature: Feature;
  checked: boolean;
  busy: boolean;
  onChange: (value: boolean) => void;
  children?: ReactNode;
}) {
  const Icon = feature.icon;
  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-4">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-af-accent/[0.12] text-af-accent">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-af-text">{feature.title}</h4>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">{feature.description}</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-af-text-4">{feature.where}</p>
        </div>
        <span className="mt-1 flex shrink-0 items-center gap-2">
          {busy && <Spinner size={14} className="text-af-text-3" />}
          <Switch checked={checked} disabled={busy} onCheckedChange={onChange} aria-label={feature.title} />
        </span>
      </div>
      {children && <div className="mt-3 sm:pl-[52px]">{children}</div>}
    </div>
  );
}

/** The learned voices, each linked to its contact. */
function LearnedVoices() {
  const profiles = useVoiceProfiles();
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);

  useEffect(() => {
    invoke<{ pyannote_available?: boolean }>('diarization_get_status')
      .then((status) => setModelsReady(!!status.pyannote_available))
      .catch(() => setModelsReady(null));
  }, []);

  return (
    <div className="space-y-2">
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
            <li key={profile.person_id} className="flex items-center gap-3 px-3 py-2">
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
              <button
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

export function LabsSettings() {
  const platform = usePlatform();
  const { labs } = useLabs();
  const [busy, setBusy] = useState<LabsFeature | null>(null);

  // Native-backed switches can outlive the WebView; show their persisted state.
  useEffect(() => {
    void syncLabsFromBackend().catch(() => undefined);
  }, []);

  const change = async (feature: Feature, value: boolean) => {
    setBusy(feature.key);
    try {
      await setLabsFeature(feature.key, value);
      if (feature.key === 'meetingAutomation' && value) {
        toast.success('Meeting automation is on', { description: 'Meeting detection is on too, so calls can start recordings.' });
      }
    } catch (error) {
      toast.error(`Could not ${value ? 'turn on' : 'turn off'} ${feature.title.toLowerCase()}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      {GROUPS.map((group) => {
        const features = group.features.filter((feature) => !feature.windowsOnly || platform === 'windows');
        if (features.length === 0) return null;
        return (
          <section key={group.title}>
            <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">{group.title}</h3>
            <div className="divide-y divide-af-border overflow-hidden rounded-2xl border border-af-border bg-af-panel-2/40">
              {features.map((feature) => (
                <FeatureRow
                  key={feature.key}
                  feature={feature}
                  checked={labs[feature.key]}
                  busy={busy === feature.key}
                  onChange={(value) => void change(feature, value)}
                >
                  {feature.key === 'voiceProfiles' && labs.voiceProfiles ? <LearnedVoices /> : null}
                </FeatureRow>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
