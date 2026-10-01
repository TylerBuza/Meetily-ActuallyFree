'use client';

/**
 * Settings, laid out like the rest of the app: sections down the left, the
 * chosen one on the right. `/settings?section=transcription` opens a section
 * directly (the home page's setup line and the command bar link here).
 */
import { Suspense, useEffect, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { invoke } from '@tauri-apps/api/core';
import { AudioLines, Cpu, FileAudio, FlaskConical, Info, Mic, Radar, Settings2, Sparkles, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useConfig } from '@/contexts/ConfigContext';
import { useImportDialog } from '@/contexts/ImportDialogContext';
import { Button } from '@/components/ui/button';
import { PreferenceSettings } from '@/components/PreferenceSettings';
import { RecordingSettings } from '@/components/RecordingSettings';
import { TranscriptSettings } from '@/components/TranscriptSettings';
import { DiarizationSettings } from '@/components/DiarizationSettings';
import { SummaryModelSettings } from '@/components/SummaryModelSettings';
import { MeetingDetectionSettings } from '@/components/MeetingDetectionSettings';
import { OptionalModelDownloads } from '@/components/OptionalModelDownloads';
import { LocalStackStatus } from '@/components/LocalStackStatus';
import { AboutSettings } from '@/components/AboutSettings';
import { LabsSettings } from '@/components/LabsSettings';
import { AppAudioCard } from '@/components/recording/AppAudioSource';

type SectionId = 'general' | 'recording' | 'transcription' | 'summaries' | 'detection' | 'local' | 'labs' | 'about';

const SECTIONS: Array<{ id: SectionId; label: string; hint: string; description: string; icon: LucideIcon }> = [
  { id: 'general', label: 'General', hint: 'Theme, name, notifications', description: 'How Meetily looks, what it calls you, and where it keeps your files.', icon: Settings2 },
  { id: 'recording', label: 'Recording', hint: 'Saving, computer audio', description: 'How recordings are saved, and which computer audio they capture.', icon: Mic },
  { id: 'transcription', label: 'Transcription', hint: 'Speech models, speakers', description: 'The speech models that write the transcript, and telling voices apart.', icon: AudioLines },
  { id: 'summaries', label: 'Summaries', hint: 'Model, language', description: 'Which AI model writes summaries and answers Ask AI, and in what language.', icon: Sparkles },
  { id: 'detection', label: 'Meeting detection', hint: 'Prompt to record', description: 'Get a prompt to record when a call starts in another app.', icon: Radar },
  { id: 'local', label: 'Local AI', hint: 'Runtime status', description: 'The on-device engines that run transcription and summaries.', icon: Cpu },
  { id: 'labs', label: 'Labs', hint: 'Experimental features', description: 'Experimental features. Each stays off until you turn it on, and may change in later versions.', icon: FlaskConical },
  { id: 'about', label: 'About', hint: 'Version, updates', description: 'Version, updates and links.', icon: Info },
];

/** Older links used tab names. */
const LEGACY_TABS: Record<string, SectionId> = {
  general: 'general',
  recording: 'recording',
  Transcriptionmodels: 'transcription',
  summaryModels: 'summaries',
  meetingDetection: 'detection',
  localStack: 'local',
  labs: 'labs',
  about: 'about',
};

const isSection = (value: string | null): value is SectionId => !!value && SECTIONS.some((section) => section.id === value);

function ImportCard() {
  const { openImportDialog } = useImportDialog();
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-af-accent/[0.12] text-af-accent">
        <FileAudio className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <h3 className="text-[15px] font-semibold text-af-text">Import a recording</h3>
        <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">
          Transcribe an audio file you already have. You can also drop a file anywhere in the window.
        </p>
      </div>
      <Button variant="secondary" size="sm" onClick={() => openImportDialog()}>
        Choose a file
      </Button>
    </div>
  );
}

function SettingsInner() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const { transcriptModelConfig, setTranscriptModelConfig } = useConfig();
  const [active, setActive] = useState<SectionId>('general');

  useEffect(() => {
    const requested = params.get('section');
    if (isSection(requested)) {
      setActive(requested);
      return;
    }
    const legacy = sessionStorage.getItem('meetily-settings-tab');
    if (legacy) {
      sessionStorage.removeItem('meetily-settings-tab');
      if (LEGACY_TABS[legacy]) setActive(LEGACY_TABS[legacy]);
    }
  }, [params]);

  useEffect(() => {
    invoke<{ provider?: string; model?: string; apiKey?: string | null } | null>('api_get_transcript_config')
      .then((config) => {
        if (!config) return;
        setTranscriptModelConfig({
          provider: (config.provider || 'localWhisper') as typeof transcriptModelConfig.provider,
          model: config.model || 'large-v3',
          apiKey: config.apiKey || null,
        });
      })
      .catch((error) => console.error('Failed to load transcript config:', error));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setTranscriptModelConfig]);

  const choose = (id: SectionId) => {
    setActive(id);
    router.replace(`${pathname}?section=${id}`, { scroll: false });
  };

  const section = SECTIONS.find((entry) => entry.id === active) ?? SECTIONS[0];

  return (
    <div className="flex h-full min-h-0 bg-af-panel">
      <nav aria-label="Settings sections" className="w-60 shrink-0 overflow-y-auto border-r border-af-border px-3 pb-6 pt-8">
        <h1 className="px-3 text-lg font-semibold tracking-tight text-af-text">Settings</h1>
        <ul className="mt-4 space-y-0.5">
          {SECTIONS.map(({ id, label, hint, icon: Icon }) => {
            const selected = id === active;
            return (
              <li key={id}>
                <button
                  type="button"
                  onClick={() => choose(id)}
                  aria-current={selected ? 'page' : undefined}
                  className={cn(
                    'group/nav flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-[background-color,color] duration-150',
                    selected ? 'bg-af-active text-af-text' : 'text-af-text-2 hover:bg-af-hover hover:text-af-text',
                  )}
                >
                  <Icon className={cn('h-4 w-4 shrink-0 transition-colors', selected ? 'text-af-accent' : 'text-af-text-3 group-hover/nav:text-af-text-2')} />
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{label}</span>
                    <span className="block truncate text-[11px] text-af-text-4">{hint}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <main className="min-w-0 flex-1 overflow-y-auto">
        <div key={section.id} className="mx-auto w-full max-w-3xl px-8 pb-24 pt-10 animate-af-rise">
          <header className="mb-6">
            <h2 className="text-xl font-semibold tracking-tight text-af-text">{section.label}</h2>
            <p className="mt-1 text-sm text-af-text-3">{section.description}</p>
          </header>
          <div className="af-settings space-y-5">
            {active === 'general' && <PreferenceSettings />}
            {active === 'recording' && (
              <>
                <RecordingSettings />
                <AppAudioCard />
                <ImportCard />
              </>
            )}
            {active === 'transcription' && (
              <>
                <TranscriptSettings transcriptModelConfig={transcriptModelConfig} setTranscriptModelConfig={setTranscriptModelConfig} />
                <DiarizationSettings />
                <OptionalModelDownloads allowUninstall />
              </>
            )}
            {active === 'summaries' && <SummaryModelSettings />}
            {active === 'detection' && <MeetingDetectionSettings />}
            {active === 'local' && <LocalStackStatus />}
            {active === 'labs' && <LabsSettings />}
            {active === 'about' && <AboutSettings />}
          </div>
        </div>
      </main>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<div className="h-full bg-af-panel" />}>
      <SettingsInner />
    </Suspense>
  );
}
