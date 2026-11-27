import { useCallback, useEffect, useRef, useState } from 'react';
import { Spinner } from '@/components/ui/spinner';
import { invoke } from '@tauri-apps/api/core';
import { OPTIONAL_MODEL_PREFERENCES_CHANGED } from '@/lib/optional-model-activation';
import { useOptionalModelDownloads } from '@/contexts/OptionalModelDownloadsContext';
import { BookOpen, Check, CheckCircle2, ChevronDown, Clock3, Languages, Radio, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { Switch } from './ui/switch';
import { RecordingPreferences } from './RecordingSettings';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';
import type { RawModelInfo } from '@/hooks/useTranscriptionModels';
import { isVisibleParakeetModel } from '@/lib/parakeet';
import { useLabs } from '@/hooks/useLabs';
import { useI18n } from '@/i18n';

export interface TranscriptModelProps {
    provider: 'localWhisper' | 'parakeet' | 'deepgram' | 'elevenLabs' | 'groq' | 'openai';
    model: string;
    apiKey?: string | null;
}

export interface TranscriptSettingsProps {
    transcriptModelConfig: TranscriptModelProps;
    setTranscriptModelConfig: (config: TranscriptModelProps) => void;
    onModelSelect?: () => void;
}

interface VocabularyConfig {
    global: string;
    meeting: string;
}

interface PostCallTranscriptConfig {
    provider: 'live' | 'whisper' | 'parakeet';
    model: string;
}

interface InstalledModel {
    provider: 'whisper' | 'parakeet';
    name: string;
}

const DEFAULT_POST_CALL_CONFIG: PostCallTranscriptConfig = {
    provider: 'live',
    model: '',
};

export function TranscriptSettings({ transcriptModelConfig, setTranscriptModelConfig, onModelSelect }: TranscriptSettingsProps) {
    const { t } = useI18n();
    const { jobs } = useOptionalModelDownloads();
    const whisperJob = jobs.whisper;
    const isWhisperDownloading = whisperJob.status === 'downloading' || whisperJob.status === 'activating';
    const [uiProvider, setUiProvider] = useState<TranscriptModelProps['provider']>(transcriptModelConfig.provider);
    const [whisperManagerOpen, setWhisperManagerOpen] = useState(false);
    const [installedModels, setInstalledModels] = useState<InstalledModel[]>([]);
    const [isSavingLive, setIsSavingLive] = useState(false);
    const [postCallConfig, setPostCallConfig] = useState<PostCallTranscriptConfig>(DEFAULT_POST_CALL_CONFIG);
    const [isLoadingPostCall, setIsLoadingPostCall] = useState(true);
    const [isSavingPostCall, setIsSavingPostCall] = useState(false);
    const [postCallSaved, setPostCallSaved] = useState(false);
    const [postCallError, setPostCallError] = useState<string | null>(null);
    const [vocabulary, setVocabulary] = useState('');
    const [isSavingVocabulary, setIsSavingVocabulary] = useState(false);
    const [vocabularySaved, setVocabularySaved] = useState(false);
    const [vocabularyError, setVocabularyError] = useState<string | null>(null);
    const [realTimeTranscription, setRealTimeTranscription] = useState(false);
    // Labs speech options that are on are named on the engine they change.
    const { labs } = useLabs();
    const vocabularyRevisionRef = useRef(0);
    const liveSaveInFlightRef = useRef(false);
    const postCallSaveInFlightRef = useRef(false);
    const postCallRevisionRef = useRef(0);
    const postCallSectionRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        let disposed = false;
        const refreshPostCall = () => {
            if (postCallSaveInFlightRef.current) return;
            const revision = ++postCallRevisionRef.current;
            void invoke<PostCallTranscriptConfig>('api_get_post_call_transcript_config').then(config => {
                if (!disposed && revision === postCallRevisionRef.current) {
                    setPostCallConfig(config);
                    setPostCallError(null);
                }
            }).catch(error => console.error('Could not refresh activated post-call model:', error));
        };
        window.addEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshPostCall);
        return () => { disposed = true; window.removeEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshPostCall); };
    }, []);

    useEffect(() => {
        invoke<RecordingPreferences>('get_recording_preferences')
            .then((p) => setRealTimeTranscription(p.real_time_transcription ?? false))
            .catch(() => {});
    }, []);

    const handleToggleRealTime = async (checked: boolean) => {
        setRealTimeTranscription(checked);
        try {
            const prefs = await invoke<RecordingPreferences>('get_recording_preferences');
            await invoke('set_recording_preferences', { preferences: { ...prefs, real_time_transcription: checked } });
            toast.success(
                checked ? t('models.fasterTranscriptionEnabled') : t('models.standardTranscriptionEnabled'),
                {
                    description: checked
                        ? t('models.streamingChunksDescription')
                        : t('models.standardChunksDescription')
                });
        } catch (e) {
            console.error('Failed to update real-time transcription preference:', e);
            toast.error(t('models.failedToUpdateStreamingPreference'));
        }
    };

    const refreshInstalledModels = useCallback(async () => {
        const [whisperModels, parakeetModels] = await Promise.all([
            invoke<RawModelInfo[]>('whisper_get_available_models').catch(() => []),
            invoke<RawModelInfo[]>('parakeet_get_available_models').catch(() => []),
        ]);
        setInstalledModels([
            ...parakeetModels
                .filter((model) => model.status === 'Available' && isVisibleParakeetModel(model.name))
                .map((model) => ({ provider: 'parakeet' as const, name: model.name })),
            ...whisperModels
                .filter((model) => model.status === 'Available')
                .map((model) => ({ provider: 'whisper' as const, name: model.name })),
        ]);
    }, []);

    useEffect(() => {
        setUiProvider(transcriptModelConfig.provider);
    }, [transcriptModelConfig.provider]);

    // Setup downloads can finish while this Settings page remains mounted.
    // Refresh installed choices as well as the preference-change subscription.
    useEffect(() => {
        if (whisperJob.status === 'ready' || whisperJob.status === 'idle' || whisperJob.status === 'activation-error') void refreshInstalledModels();
    }, [whisperJob.status, refreshInstalledModels]);

    useEffect(() => {
        const requestedSection = sessionStorage.getItem('meetily-settings-transcription-section');
        sessionStorage.removeItem('meetily-settings-transcription-section');
        sessionStorage.removeItem('meetily-settings-transcription-provider');
        if (requestedSection === 'post-call') {
            setWhisperManagerOpen(true);
            window.setTimeout(() => postCallSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100);
        }
    }, []);

    useEffect(() => {
        void refreshInstalledModels();
        const revision = postCallRevisionRef.current;
        invoke<PostCallTranscriptConfig>('api_get_post_call_transcript_config')
            .then((config) => { if (revision === postCallRevisionRef.current) setPostCallConfig(config || DEFAULT_POST_CALL_CONFIG); })
            .catch((error) => {
                console.error('Failed to load post-call transcription config:', error);
                setPostCallError(t('models.couldNotLoadPostCallPreference'));
            })
            .finally(() => setIsLoadingPostCall(false));
    }, [refreshInstalledModels]);

    useEffect(() => {
        const revision = vocabularyRevisionRef.current;
        invoke<VocabularyConfig>('api_get_vocabulary', { meetingId: null })
            .then((config) => {
                if (vocabularyRevisionRef.current === revision) {
                    setVocabulary(config.global || '');
                }
            })
            .catch((error) => {
                console.error('Failed to load vocabulary:', error);
                setVocabularyError(t('models.couldNotLoadVocabulary'));
            });
    }, []);

    const saveLiveConfig = async (provider: 'localWhisper' | 'parakeet', model: string): Promise<boolean> => {
        if (liveSaveInFlightRef.current) return false;
        liveSaveInFlightRef.current = true;
        setIsSavingLive(true);
        const nextConfig: TranscriptModelProps = {
            ...transcriptModelConfig,
            provider,
            model,
            apiKey: null,
        };
        try {
            await invoke('api_save_transcript_config', {
                provider,
                model,
                apiKey: null,
            });
            setUiProvider(provider);
            setTranscriptModelConfig(nextConfig);
            onModelSelect?.();
            return true;
        } catch (error) {
            toast.error(t('models.couldNotSaveLiveModel'), {
                description: typeof error === 'string' ? error : String(error),
            });
            return false;
        } finally {
            liveSaveInFlightRef.current = false;
            setIsSavingLive(false);
        }
    };

    const savePostCallConfig = async (nextConfig: PostCallTranscriptConfig): Promise<boolean> => {
        if (postCallSaveInFlightRef.current) return false;
        postCallSaveInFlightRef.current = true;
        const previousConfig = postCallConfig;
        const revision = ++postCallRevisionRef.current;
        setPostCallConfig(nextConfig);
        setIsSavingPostCall(true);
        setPostCallSaved(false);
        setPostCallError(null);
        try {
            await invoke('api_save_post_call_transcript_config', {
                provider: nextConfig.provider,
                model: nextConfig.model,
            });
            window.dispatchEvent(new Event(OPTIONAL_MODEL_PREFERENCES_CHANGED));
            if (postCallRevisionRef.current === revision) {
                setPostCallSaved(true);
                window.setTimeout(() => setPostCallSaved(false), 2000);
            }
            return true;
        } catch (error) {
            if (postCallRevisionRef.current === revision) {
                setPostCallConfig(previousConfig);
                setPostCallError(typeof error === 'string' ? error : String(error));
            }
            return false;
        } finally {
            postCallSaveInFlightRef.current = false;
            if (postCallRevisionRef.current === revision) {
                setIsSavingPostCall(false);
            }
        }
    };

    const handlePostCallWhisperSelect = async (modelName: string) => {
        void refreshInstalledModels();
        if (!modelName) {
            if (postCallConfig.provider === 'whisper') {
                const saved = await savePostCallConfig(DEFAULT_POST_CALL_CONFIG);
                if (!saved) return false;
            }
            if (uiProvider === 'localWhisper') {
                const parakeetFallback = installedModels.find((model) => model.provider === 'parakeet');
                if (parakeetFallback) {
                    await saveLiveConfig('parakeet', parakeetFallback.name);
                }
            }
            return true;
        }
        const saved = await savePostCallConfig({ provider: 'whisper', model: modelName });
        if (!saved) return false;
        return true;
    };

    const handleParakeetModelSelect = async (modelName: string) => {
        if (!modelName) return;
        const saved = await saveLiveConfig('parakeet', modelName);
        void refreshInstalledModels();
        return saved;
    };

    const saveVocabulary = async () => {
        setIsSavingVocabulary(true);
        setVocabularySaved(false);
        setVocabularyError(null);
        const revision = vocabularyRevisionRef.current;
        try {
            const normalized = await invoke<string>('api_save_global_vocabulary', { vocabulary });
            if (vocabularyRevisionRef.current === revision) {
                setVocabulary(normalized);
            }
            setVocabularySaved(true);
            window.setTimeout(() => setVocabularySaved(false), 2000);
        } catch (error) {
            setVocabularyError(typeof error === 'string' ? error : String(error));
        } finally {
            setIsSavingVocabulary(false);
        }
    };

    const installedWhisperModels = installedModels.filter((model) => model.provider === 'whisper');
    const installedParakeetModel = installedModels.find((model) => model.provider === 'parakeet');
    const liveWhisperModel = installedWhisperModels.find((model) => model.name === transcriptModelConfig.model)
        || (postCallConfig.provider === 'whisper'
            ? installedWhisperModels.find((model) => model.name === postCallConfig.model)
            : undefined)
        || installedWhisperModels[0];
    const effectivePostCallProvider = postCallConfig.provider === 'live'
        ? (uiProvider === 'localWhisper' ? 'whisper' : 'parakeet')
        : postCallConfig.provider;
    const effectivePostCallModel = postCallConfig.provider === 'live'
        ? transcriptModelConfig.model
        : postCallConfig.model;
    const postCallWhisperModel = installedWhisperModels.find((model) => model.name === effectivePostCallModel)
        || installedWhisperModels[0];
    const openWhisperManager = () => {
        setWhisperManagerOpen(true);
        window.setTimeout(() => postCallSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    };

    return (
        <div className="space-y-6 pb-6">
            <section className="space-y-4 rounded-2xl border border-af-border bg-af-panel-2/40 p-5 text-af-text">
                <div className="flex items-start gap-3">
                    <Radio className="mt-0.5 h-5 w-5 shrink-0 text-af-accent" />
                    <div className="min-w-0 flex-1">
                        <h3 className="font-semibold">{t('models.liveTitle')}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t('models.liveDescription')}
                        </p>
                    </div>
                </div>

                <div
                    className={`space-y-4 rounded-xl border p-4 transition-colors ${installedParakeetModel && !isSavingLive ? 'cursor-pointer hover:border-[var(--af-accent)]' : ''} ${uiProvider === 'parakeet'
                    ? 'border-[var(--af-accent)] bg-[var(--af-accent-soft)] ring-1 ring-af-accent/50'
                    : 'border-[var(--af-border-strong)] bg-[var(--af-panel-2)]'}`}
                    role={installedParakeetModel ? 'button' : undefined}
                    tabIndex={installedParakeetModel ? 0 : undefined}
                    aria-pressed={uiProvider === 'parakeet'}
                    onClick={() => {
                        if (installedParakeetModel && !isSavingLive) {
                            void saveLiveConfig('parakeet', installedParakeetModel.name);
                        }
                    }}
                    onKeyDown={(event) => {
                        if (installedParakeetModel && !isSavingLive && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault();
                            void saveLiveConfig('parakeet', installedParakeetModel.name);
                        }
                    }}
                >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                            <Zap className="mt-0.5 h-5 w-5 shrink-0 text-af-warning" />
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="font-semibold">Parakeet</h4>
                                    <span className="rounded-full bg-af-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-success">
                                        {t('models.recommendedForLive')}
                                    </span>
                                    {labs.parakeetGpu && (
                                        <span className="rounded-full border border-af-accent/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
                                            {t('models.gpuLabs')}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-sm text-[var(--af-text-2)]">
                                    {t('models.parakeetLiveDescription')}
                                </p>
                            </div>
                        </div>
                        {uiProvider === 'parakeet' ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-af-accent/40 bg-af-accent/10 px-2.5 py-1 text-xs font-medium text-af-accent">
                                <CheckCircle2 className="h-3.5 w-3.5" /> {t('models.selectedForLive')}
                            </span>
                        ) : installedParakeetModel ? (
                            <span className="rounded-full border border-[var(--af-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--af-text-2)]">
                                {t('models.clickToSelect')}
                            </span>
                        ) : (
                            <span className="text-xs text-[var(--af-text-3)]">{t('models.downloadBelow')}</span>
                        )}
                    </div>
                    <div className={isSavingLive ? 'pointer-events-none opacity-70' : ''} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                        <ParakeetModelManager
                            selectedModel={uiProvider === 'parakeet' ? transcriptModelConfig.model : undefined}
                            onModelSelect={handleParakeetModelSelect}
                            autoSave={false}
                        />
                    </div>
                </div>

                <div
                    className={`space-y-4 rounded-xl border p-4 transition-colors ${liveWhisperModel && !isSavingLive ? 'cursor-pointer hover:border-[var(--af-accent)]' : ''} ${uiProvider === 'localWhisper'
                    ? 'border-[var(--af-accent)] bg-[var(--af-accent-soft)] ring-1 ring-af-accent/50'
                    : 'border-[var(--af-border-strong)] bg-[var(--af-panel-2)]'}`}
                    role={liveWhisperModel ? 'button' : undefined}
                    tabIndex={liveWhisperModel ? 0 : undefined}
                    aria-pressed={uiProvider === 'localWhisper'}
                    onClick={() => {
                        if (liveWhisperModel && !isSavingLive) {
                            void saveLiveConfig('localWhisper', liveWhisperModel.name);
                        }
                    }}
                    onKeyDown={(event) => {
                        if (liveWhisperModel && !isSavingLive && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault();
                            void saveLiveConfig('localWhisper', liveWhisperModel.name);
                        }
                    }}
                >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                            <Languages className="mt-0.5 h-5 w-5 shrink-0 text-af-accent" />
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="font-semibold">Whisper</h4>
                                    <span className="rounded-full bg-af-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
                                        {t('models.betterForPostCall')}
                                    </span>
                                    {labs.whisperSilenceGuard && (
                                        <span className="rounded-full border border-af-accent/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
                                            {t('models.silenceGuardLabs')}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-sm text-[var(--af-text-2)]">
                                    {t('models.whisperLiveDescription')}
                                </p>
                            </div>
                        </div>
                        {uiProvider === 'localWhisper' ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-af-accent/40 bg-af-accent/10 px-2.5 py-1 text-xs font-medium text-af-accent">
                                <CheckCircle2 className="h-3.5 w-3.5" /> {t('models.selectedForLive')}
                            </span>
                        ) : liveWhisperModel ? (
                            <span className="rounded-full border border-[var(--af-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--af-text-2)]">
                                {t('models.clickToSelect')}
                            </span>
                        ) : null}
                    </div>
                    {liveWhisperModel ? (
                        <p className="text-xs text-[var(--af-text-3)]">
                            {t('models.usesWhisperInstalled', { model: liveWhisperModel.name })}
                        </p>
                    ) : (
                        <Button type="button" variant="outline" className="w-full" onClick={(event) => {
                            event.stopPropagation();
                            openWhisperManager();
                        }}>
                            {t('models.installWhisperForUse')}
                        </Button>
                    )}
                </div>

                {/* Faster Transcription Toggle */}
                <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--af-border-strong)] bg-[var(--af-panel)] p-4">
                    <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 font-semibold">
                            <Zap className="h-4 w-4 text-af-warning" />
                            {t('models.fasterTranscription')}
                        </div>
                        <p className="mt-1 text-xs text-[var(--af-text-2)]">
                            {t('models.fasterTranscriptionDescription')}
                        </p>
                        <p className="mt-1.5 text-xs text-af-warning font-medium">
                            {t('models.fasterTranscriptionDisclaimer')}
                        </p>
                    </div>
                    <Switch
                        checked={realTimeTranscription}
                        onCheckedChange={handleToggleRealTime}
                        className="shrink-0"
                    />
                </div>
            </section>

            <section ref={postCallSectionRef} className="scroll-mt-6 space-y-4 rounded-2xl border border-af-border bg-af-panel-2/40 p-5 text-af-text">
                <div className="flex items-start gap-3">
                    <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-af-accent" />
                    <div className="min-w-0 flex-1">
                        <h3 className="font-semibold">{t('models.postCallTitle')}</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t('models.postCallDescription')}
                        </p>
                    </div>
                </div>

                <div
                    className={`space-y-3 rounded-xl border p-4 transition-colors ${postCallWhisperModel && !isLoadingPostCall && !isSavingPostCall ? 'cursor-pointer hover:border-[var(--af-accent)]' : ''} ${effectivePostCallProvider === 'whisper'
                    ? 'border-[var(--af-accent)] bg-[var(--af-accent-soft)] ring-1 ring-af-accent/50'
                    : 'border-[var(--af-border-strong)] bg-[var(--af-panel-2)]'}`}
                    role={postCallWhisperModel ? 'button' : undefined}
                    tabIndex={postCallWhisperModel ? 0 : undefined}
                    aria-pressed={effectivePostCallProvider === 'whisper'}
                    onClick={() => {
                        if (postCallWhisperModel && !isLoadingPostCall && !isSavingPostCall) {
                            void savePostCallConfig({ provider: 'whisper', model: postCallWhisperModel.name });
                        }
                    }}
                    onKeyDown={(event) => {
                        if (postCallWhisperModel && !isLoadingPostCall && !isSavingPostCall && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault();
                            void savePostCallConfig({ provider: 'whisper', model: postCallWhisperModel.name });
                        }
                    }}
                >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                            <Languages className="mt-0.5 h-5 w-5 shrink-0 text-af-accent" />
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="font-semibold">Whisper</h4>
                                    <span className="rounded-full bg-af-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
                                        {t('models.recommendedForPostCall')}
                                    </span>
                                        <span className="rounded-full bg-af-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
                                            {t('models.promptBasedHints')}
                                    </span>
                                    {labs.whisperSilenceGuard && (
                                        <span className="rounded-full border border-af-accent/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
                                            {t('models.silenceGuardLabs')}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-sm text-[var(--af-text-2)]">
                                    {t('models.whisperPostCallDescription')}
                                </p>
                            </div>
                        </div>
                        {effectivePostCallProvider === 'whisper' ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-af-accent/40 bg-af-accent/10 px-2.5 py-1 text-xs font-medium text-af-accent">
                                <CheckCircle2 className="h-3.5 w-3.5" /> {t('models.selectedForPostCall')}
                            </span>
                        ) : postCallWhisperModel ? (
                            <span className="rounded-full border border-[var(--af-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--af-text-2)]">
                                {t('models.clickToSelect')}
                            </span>
                        ) : null}
                    </div>
                    {isWhisperDownloading ? (
                        <div className="space-y-2 border-t border-af-border pt-3">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
                                <span>{whisperJob.status === 'activating' ? t('models.enablingModel') : t('models.downloadingWhisper')}</span>
                                <span className="tabular-nums">{Math.round(whisperJob.progress)}%</span>
                            </div>
                            <div role="progressbar" aria-label={t('models.whisperDownloadProgress')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={whisperJob.progress} className="h-1.5 overflow-hidden rounded-full bg-af-hover">
                                <div className="h-full rounded-full bg-af-accent transition-[width] duration-150" style={{ width: `${whisperJob.progress}%` }} />
                            </div>
                        </div>
                    ) : postCallWhisperModel ? (
                        <p className="text-xs text-[var(--af-text-3)]">
                            {t('models.usesWhisperSpecific', { model: postCallWhisperModel.name })}
                        </p>
                    ) : (
                        <Button type="button" variant="outline" className="w-full" onClick={(event) => {
                            event.stopPropagation();
                            openWhisperManager();
                        }}>
                            {t('models.installWhisperModel')}
                        </Button>
                    )}
                </div>

                <div
                    className={`space-y-3 rounded-xl border p-4 transition-colors ${installedParakeetModel && !isLoadingPostCall && !isSavingPostCall ? 'cursor-pointer hover:border-[var(--af-accent)]' : ''} ${effectivePostCallProvider === 'parakeet'
                    ? 'border-[var(--af-accent)] bg-[var(--af-accent-soft)] ring-1 ring-af-accent/50'
                    : 'border-[var(--af-border-strong)] bg-[var(--af-panel-2)]'}`}
                    role={installedParakeetModel ? 'button' : undefined}
                    tabIndex={installedParakeetModel ? 0 : undefined}
                    aria-pressed={effectivePostCallProvider === 'parakeet'}
                    onClick={() => {
                        if (installedParakeetModel && !isLoadingPostCall && !isSavingPostCall) {
                            void savePostCallConfig({ provider: 'parakeet', model: installedParakeetModel.name });
                        }
                    }}
                    onKeyDown={(event) => {
                        if (installedParakeetModel && !isLoadingPostCall && !isSavingPostCall && (event.key === 'Enter' || event.key === ' ')) {
                            event.preventDefault();
                            void savePostCallConfig({ provider: 'parakeet', model: installedParakeetModel.name });
                        }
                    }}
                >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="flex min-w-0 items-start gap-3">
                            <Zap className="mt-0.5 h-5 w-5 shrink-0 text-af-warning" />
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="font-semibold">Parakeet</h4>
                                    <span className="rounded-full bg-af-success/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-success">
                                        {t('models.fastAndAccurate')}
                                    </span>
                                    {labs.parakeetGpu && (
                                        <span className="rounded-full border border-af-accent/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
                                            {t('models.gpuLabs')}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-1 text-sm text-[var(--af-text-2)]">
                                    {t('models.parakeetPostCallDescription')}
                                </p>
                            </div>
                        </div>
                        {effectivePostCallProvider === 'parakeet' ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-af-accent/40 bg-af-accent/10 px-2.5 py-1 text-xs font-medium text-af-accent">
                                <CheckCircle2 className="h-3.5 w-3.5" /> {t('models.selectedForPostCall')}
                            </span>
                        ) : installedParakeetModel ? (
                            <span className="rounded-full border border-[var(--af-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--af-text-2)]">
                                {t('models.clickToSelect')}
                            </span>
                        ) : (
                            <span className="text-xs text-[var(--af-text-3)]">{t('models.installParakeetAbove')}</span>
                        )}
                    </div>
                </div>

                <div className="min-h-5 text-xs">
                    {postCallError ? (
                        <span className="text-af-danger">{postCallError}</span>
                    ) : postCallSaved ? (
                        <span className="inline-flex items-center gap-1 text-af-success"><Check className="h-3.5 w-3.5" /> {t('models.postCallDefaultSaved')}</span>
                    ) : postCallConfig.provider === 'live' ? (
                        <span className="text-[var(--af-text-3)]">{t('models.followsLiveModel')}</span>
                    ) : null}
                </div>

                <details
                    open={whisperManagerOpen}
                    onToggle={(event) => setWhisperManagerOpen(event.currentTarget.open)}
                    className="group rounded-lg border border-[var(--af-border-strong)] bg-[var(--af-panel-2)]"
                >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                        <span>{t('models.installOrManageWhisperModels')}</span>
                        <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform group-open:rotate-180" />
                    </summary>
                    <div className={`border-t border-[var(--af-border)] bg-[var(--af-panel-2)] px-4 py-4 ${isSavingPostCall ? 'pointer-events-none opacity-70' : ''}`}>
                        <ModelManager
                            selectedModel={effectivePostCallProvider === 'whisper' ? effectivePostCallModel : undefined}
                            onModelSelect={handlePostCallWhisperSelect}
                            autoSave={false}
                        />
                    </div>
                </details>
            </section>

            <section className="space-y-3 rounded-xl border border-[var(--af-border)] bg-[var(--af-panel-2)] p-4 text-[var(--af-text)]">
                <div className="flex items-start gap-3">
                    <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-af-accent" />
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <Label htmlFor="transcription-vocabulary" className="text-sm font-medium">{t('models.globalVocabularyHints')}</Label>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            {t('models.globalVocabularyDescription')}
                        </p>
                    </div>
                </div>
                <Textarea
                    id="transcription-vocabulary"
                    value={vocabulary}
                    onChange={(event) => {
                        vocabularyRevisionRef.current += 1;
                        setVocabulary(event.target.value);
                        setVocabularySaved(false);
                        setVocabularyError(null);
                    }}
                    maxLength={1000}
                    rows={5}
                    disabled={isSavingVocabulary}
                    placeholder={'Meetily\nTauri\nKubernetes\nOKR'}
                    className="resize-y"
                />
                <div className="flex items-center justify-between gap-3">
                    <div className="min-h-5 text-xs">
                        {vocabularyError ? (
                            <span className="text-af-danger">{vocabularyError}</span>
                        ) : vocabularySaved ? (
                            <span className="inline-flex items-center gap-1 text-af-success"><Check className="h-3.5 w-3.5" /> {t('models.saved')}</span>
                        ) : (
                            <span className="text-muted-foreground">{t('models.charactersCount', { count: vocabulary.length })}</span>
                        )}
                    </div>
                    <Button type="button" size="sm" onClick={saveVocabulary} disabled={isSavingVocabulary}>
                        {isSavingVocabulary && <Spinner className="mr-2 h-4 w-4 " />}
                        {t('models.saveVocabulary')}
                    </Button>
                </div>
            </section>
        </div>
    );
}
