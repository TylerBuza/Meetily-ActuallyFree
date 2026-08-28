import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { BookOpen, Check, CheckCircle2, ChevronDown, Clock3, Languages, Loader2, Radio, Zap } from 'lucide-react';
import { toast } from 'sonner';
import { Textarea } from './ui/textarea';
import { Button } from './ui/button';
import { Label } from './ui/label';
import { ModelManager } from './WhisperModelManager';
import { ParakeetModelManager } from './ParakeetModelManager';
import type { RawModelInfo } from '@/hooks/useTranscriptionModels';
import { isVisibleParakeetModel } from '@/lib/parakeet';

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
    const vocabularyRevisionRef = useRef(0);
    const liveSaveInFlightRef = useRef(false);
    const postCallSaveInFlightRef = useRef(false);
    const postCallRevisionRef = useRef(0);
    const postCallSectionRef = useRef<HTMLDivElement>(null);

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
        invoke<PostCallTranscriptConfig>('api_get_post_call_transcript_config')
            .then((config) => setPostCallConfig(config || DEFAULT_POST_CALL_CONFIG))
            .catch((error) => {
                console.error('Failed to load post-call transcription config:', error);
                setPostCallError('Could not load the post-call model preference.');
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
                setVocabularyError('Could not load the saved vocabulary.');
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
            toast.error('Could not save the live transcription model', {
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
            <section className="space-y-4 rounded-xl border border-[var(--af-border)] bg-[var(--af-panel-2)] p-4 text-[var(--af-text)] sm:p-5">
                <div className="flex items-start gap-3">
                    <Radio className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
                    <div className="min-w-0 flex-1">
                        <h3 className="font-semibold">Live transcription</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Choose the model used while recording. Parakeet is recommended for most live meetings; Whisper remains available when manual language control and broader coverage matter more than speed.
                        </p>
                    </div>
                </div>

                <div
                    className={`space-y-4 rounded-xl border p-4 transition-colors ${installedParakeetModel && !isSavingLive ? 'cursor-pointer hover:border-[var(--af-accent)]' : ''} ${uiProvider === 'parakeet'
                    ? 'border-[var(--af-accent)] bg-[var(--af-accent-soft)] ring-1 ring-blue-500/20'
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
                            <Zap className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="font-semibold">Parakeet</h4>
                                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-500">
                                        Recommended for live
                                    </span>
                                </div>
                                <p className="mt-1 text-sm text-[var(--af-text-2)]">
                                    Best for live meetings: lower latency, lighter resource use, strong real-time accuracy, and contextual vocabulary hints.
                                </p>
                            </div>
                        </div>
                        {uiProvider === 'parakeet' ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-400">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Selected for live
                            </span>
                        ) : installedParakeetModel ? (
                            <span className="rounded-full border border-[var(--af-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--af-text-2)]">
                                Click to select
                            </span>
                        ) : (
                            <span className="text-xs text-[var(--af-text-3)]">Download below</span>
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
                    ? 'border-[var(--af-accent)] bg-[var(--af-accent-soft)] ring-1 ring-blue-500/20'
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
                            <Languages className="mt-0.5 h-5 w-5 shrink-0 text-violet-400" />
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="font-semibold">Whisper</h4>
                                    <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-400">
                                        Better for post-call
                                    </span>
                                </div>
                                <p className="mt-1 text-sm text-[var(--af-text-2)]">
                                    Best as a post-call second pass. Whisper is slower and heavier during live meetings, but supports manual language selection and broad multilingual transcription.
                                </p>
                            </div>
                        </div>
                        {uiProvider === 'localWhisper' ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-400">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Selected for live
                            </span>
                        ) : liveWhisperModel ? (
                            <span className="rounded-full border border-[var(--af-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--af-text-2)]">
                                Click to select
                            </span>
                        ) : null}
                    </div>
                    {liveWhisperModel ? (
                        <p className="text-xs text-[var(--af-text-3)]">
                            Uses Whisper: {liveWhisperModel.name}. Change the installed model under Manage Whisper models below.
                        </p>
                    ) : (
                        <Button type="button" variant="outline" className="w-full" onClick={(event) => {
                            event.stopPropagation();
                            openWhisperManager();
                        }}>
                            Install Whisper for post-call or live use
                        </Button>
                    )}
                </div>
            </section>

            <section ref={postCallSectionRef} className="scroll-mt-6 space-y-4 rounded-xl border border-[var(--af-border)] bg-[var(--af-panel-2)] p-4 text-[var(--af-text)] sm:p-5">
                <div className="flex items-start gap-3">
                    <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-violet-500" />
                    <div className="min-w-0 flex-1">
                        <h3 className="font-semibold">Post-call retranscription</h3>
                        <p className="mt-1 text-sm text-muted-foreground">
                            Choose the default for automatic enhancement after recording. You can still override it for each meeting.
                        </p>
                    </div>
                </div>

                <div
                    className={`space-y-3 rounded-xl border p-4 transition-colors ${postCallWhisperModel && !isLoadingPostCall && !isSavingPostCall ? 'cursor-pointer hover:border-[var(--af-accent)]' : ''} ${effectivePostCallProvider === 'whisper'
                    ? 'border-[var(--af-accent)] bg-[var(--af-accent-soft)] ring-1 ring-blue-500/20'
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
                            <Languages className="mt-0.5 h-5 w-5 shrink-0 text-violet-400" />
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="font-semibold">Whisper</h4>
                                    <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-400">
                                        Recommended for post-call
                                    </span>
                                    <span className="rounded-full bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-400">
                                        Prompt-based hints
                                    </span>
                                </div>
                                <p className="mt-1 text-sm text-[var(--af-text-2)]">
                                    Whisper is slower and uses more resources, but offers a different post-call pass for difficult audio and manual language control. It uses your global vocabulary as an initial prompt.
                                </p>
                            </div>
                        </div>
                        {effectivePostCallProvider === 'whisper' ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-400">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Selected for post-call
                            </span>
                        ) : postCallWhisperModel ? (
                            <span className="rounded-full border border-[var(--af-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--af-text-2)]">
                                Click to select
                            </span>
                        ) : null}
                    </div>
                    {postCallWhisperModel ? (
                        <p className="text-xs text-[var(--af-text-3)]">
                            Uses Whisper: {postCallWhisperModel.name}. Change the specific model under Manage Whisper models below.
                        </p>
                    ) : (
                        <Button type="button" variant="outline" className="w-full" onClick={(event) => {
                            event.stopPropagation();
                            openWhisperManager();
                        }}>
                            Install a Whisper model
                        </Button>
                    )}
                </div>

                <div
                    className={`space-y-3 rounded-xl border p-4 transition-colors ${installedParakeetModel && !isLoadingPostCall && !isSavingPostCall ? 'cursor-pointer hover:border-[var(--af-accent)]' : ''} ${effectivePostCallProvider === 'parakeet'
                    ? 'border-[var(--af-accent)] bg-[var(--af-accent-soft)] ring-1 ring-blue-500/20'
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
                            <Zap className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                            <div>
                                <div className="flex flex-wrap items-center gap-2">
                                    <h4 className="font-semibold">Parakeet</h4>
                                    <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-500">
                                        Fast and accurate
                                    </span>
                                </div>
                                <p className="mt-1 text-sm text-[var(--af-text-2)]">
                                    Finishes post-call enhancement sooner and uses fewer resources while maintaining strong accuracy. It applies global and meeting vocabulary through contextual biasing.
                                </p>
                            </div>
                        </div>
                        {effectivePostCallProvider === 'parakeet' ? (
                            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/40 bg-blue-500/10 px-2.5 py-1 text-xs font-medium text-blue-400">
                                <CheckCircle2 className="h-3.5 w-3.5" /> Selected for post-call
                            </span>
                        ) : installedParakeetModel ? (
                            <span className="rounded-full border border-[var(--af-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--af-text-2)]">
                                Click to select
                            </span>
                        ) : (
                            <span className="text-xs text-[var(--af-text-3)]">Install Parakeet above</span>
                        )}
                    </div>
                </div>

                <div className="min-h-5 text-xs">
                    {postCallError ? (
                        <span className="text-red-500">{postCallError}</span>
                    ) : postCallSaved ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600"><Check className="h-3.5 w-3.5" /> Post-call default saved</span>
                    ) : postCallConfig.provider === 'live' ? (
                        <span className="text-[var(--af-text-3)]">This currently follows your live model. Choosing either card makes post-call selection independent.</span>
                    ) : null}
                </div>

                <details
                    open={whisperManagerOpen}
                    onToggle={(event) => setWhisperManagerOpen(event.currentTarget.open)}
                    className="group rounded-lg border border-[var(--af-border-strong)] bg-[var(--af-panel-2)]"
                >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-sm font-medium">
                        <span>Install or manage Whisper models</span>
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
                    <BookOpen className="mt-0.5 h-4 w-4 shrink-0 text-blue-500" />
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <Label htmlFor="transcription-vocabulary" className="text-sm font-medium">Global vocabulary hints</Label>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                            Help Parakeet or Whisper recognize names, companies, products, acronyms, and technical terms. Parakeet uses contextual phrase boosting; Whisper uses up to 224 prompt tokens.
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
                            <span className="text-red-500">{vocabularyError}</span>
                        ) : vocabularySaved ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600"><Check className="h-3.5 w-3.5" /> Saved</span>
                        ) : (
                            <span className="text-muted-foreground">{vocabulary.length}/1000 characters</span>
                        )}
                    </div>
                    <Button type="button" size="sm" onClick={saveVocabulary} disabled={isSavingVocabulary}>
                        {isSavingVocabulary && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save vocabulary
                    </Button>
                </div>
            </section>
        </div>
    );
}
