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
import { useI18n, type MessageKey } from '@/i18n';

interface Feature {
  key: LabsFeature;
  icon: LucideIcon;
  title: MessageKey;
  description: MessageKey;
  /** Where it shows up or applies once on. */
  where: MessageKey;
  windowsOnly?: boolean;
}

const GROUPS: Array<{ title: MessageKey; features: Feature[] }> = [
  {
    title: 'labs.groupMeetings',
    features: [
      {
        key: 'meetingAutomation',
        icon: Workflow,
        title: 'labs.meetingAutomationTitle',
        description: 'labs.meetingAutomationDescription',
        where: 'labs.meetingAutomationWhere',
      },
    ],
  },
  {
    title: 'labs.groupPlaybackTranscript',
    features: [
      {
        key: 'transcriptScrubbing',
        icon: AudioWaveform,
        title: 'labs.waveformScrubbingTitle',
        description: 'labs.waveformScrubbingDescription',
        where: 'labs.waveformScrubbingWhere',
      },
      {
        key: 'cleanTranscript',
        icon: Eraser,
        title: 'labs.cleanTranscriptTitle',
        description: 'labs.cleanTranscriptDescription',
        where: 'labs.cleanTranscriptWhere',
      },
    ],
  },
  {
    title: 'labs.groupSpeechRecognition',
    features: [
      {
        key: 'whisperSilenceGuard',
        icon: VolumeX,
        title: 'labs.whisperSilenceGuardTitle',
        description: 'labs.whisperSilenceGuardDescription',
        where: 'labs.whisperSilenceGuardWhere',
      },
      {
        key: 'parakeetGpu',
        icon: Gauge,
        title: 'labs.parakeetGpuTitle',
        description: 'labs.parakeetGpuDescription',
        where: 'labs.parakeetGpuWhere',
        windowsOnly: true,
      },
    ],
  },
  {
    title: 'labs.groupVoices',
    features: [
      {
        key: 'voiceProfiles',
        icon: Fingerprint,
        title: 'labs.voiceProfilesTitle',
        description: 'labs.voiceProfilesDescription',
        where: 'labs.voiceProfilesWhere',
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
  const { t } = useI18n();
  const Icon = feature.icon;
  return (
    <div className="px-5 py-4">
      <div className="flex items-start gap-4">
        <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-af-accent/[0.12] text-af-accent">
          <Icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-af-text">{t(feature.title)}</h4>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">{t(feature.description)}</p>
          <p className="mt-1.5 text-[11px] leading-relaxed text-af-text-4">{t(feature.where)}</p>
        </div>
        <span className="mt-1 flex shrink-0 items-center gap-2">
          {busy && <Spinner size={14} className="text-af-text-3" />}
          <Switch checked={checked} disabled={busy} onCheckedChange={onChange} aria-label={t(feature.title)} />
        </span>
      </div>
      {children && <div className="mt-3 sm:pl-[52px]">{children}</div>}
    </div>
  );
}

/** The learned voices, each linked to its contact. */
function LearnedVoices() {
  const { t } = useI18n();
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
          {t('labs.voiceProfilesNeedModels')}
          <Link href="/settings?section=transcription" className="font-medium text-af-accent hover:underline">
            {t('labs.downloadThemInTranscription')}
          </Link>
          {t('labs.sentencePeriod')}
        </p>
      )}
      {profiles === null ? (
        <div className="af-skeleton h-10 rounded-lg" />
      ) : profiles.length === 0 ? (
        <p className="text-xs leading-relaxed text-af-text-3">
          {t('labs.noVoicesYet')}
          <Link href="/contacts" className="font-medium text-af-accent hover:underline">
            {t('labs.contactsLink')}
          </Link>
          {t('labs.noVoicesYetTail')}
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
                aria-label={t('labs.forgetVoiceAria', { name: profile.name })}
                onClick={() =>
                  forgetVoice(profile.person_id)
                    .then(() => toast.success(t('labs.forgotVoice', { name: profile.name })))
                    .catch((error) => toast.error(t('labs.couldNotForgetVoice'), { description: describeVoiceError(error) }))
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
  const { t } = useI18n();
  const platform = usePlatform();
  const { labs } = useLabs();
  const [busy, setBusy] = useState<LabsFeature | null>(null);

  // Three switches live in Rust; show what it actually has.
  useEffect(() => {
    void syncLabsFromBackend().catch(() => undefined);
  }, []);

  const change = async (feature: Feature, value: boolean) => {
    setBusy(feature.key);
    try {
      await setLabsFeature(feature.key, value);
      if (feature.key === 'meetingAutomation' && value) {
        toast.success(t('labs.meetingAutomationOn'), { description: t('labs.meetingAutomationOnDescription') });
      }
    } catch (error) {
      toast.error(
        value
          ? t('labs.couldNotTurnOn', { feature: t(feature.title).toLowerCase() })
          : t('labs.couldNotTurnOff', { feature: t(feature.title).toLowerCase() }),
        {
          description: error instanceof Error ? error.message : String(error),
        }
      );
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
            <h3 className="mb-2 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-af-text-4">{t(group.title)}</h3>
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
