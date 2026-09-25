import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { OPTIONAL_MODEL_PREFERENCES_CHANGED } from '@/lib/optional-model-activation';
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

interface WhisperVocabularyConfig {
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
        const revision = postCallRevisionRef.current;
        invoke<PostCallTranscriptConfig>('api_get_post_call_transcript_config')
            .then((config) => { if (revision === postCallRevisionRef.current) setPostCallConfig(config || DEFAULT_POST_CALL_CONFIG); })
            .catch((error) => {
                console.error('Failed to load post-call transcription config:', error);
                setPostCallError('Could not load the post-call model preference.');
            })
            .finally(() => setIsLoadingPostCall(false));
    }, [refreshInstalledModels]);

    useEffect(() => {
        const revision = vocabularyRevisionRef.current;
        invoke<WhisperVocabularyConfig>('api_get_whisper_vocabulary', { meetingId: null })
            .then((config) => {
                if (vocabularyRevisionRef.current === revision) {
                    setVocabulary(config.global || '');
                }
            })
            .catch((error) => {
                console.error('Failed to load Whisper vocabulary:', error);
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
            const normalized = await invoke<string>('api_save_global_whisper_vocabulary', { vocabulary });
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

    const whisperIsActive = uiProvider === 'localWhisper' || postCallConfig.provider === 'whisper';
    const openWhisperManager = () => {
        setWhisperManagerOpen(true);
        window.setTimeout(() => postCallSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    };

    return (
        <div className="space-y-6 pb-6">
            {/* Live Transcription Section */}
            <section className="space-y-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1218] p-4 text-slate-900 dark:text-slate-100 shadow-sm sm:p-5">
                <div className="flex items-start gap-3">
                    <Radio className="mt-0.5 h-5 w-5 shrink-0 text-blue-500" />
                    <div className="min-w-0 flex-1">
                        <h3 className="font-semibold text-base text-slate-900 dark:text-slate-100">Live transcription</h3>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                            Choose the model used while recording. Select between ultra-fast Parakeet or multilingual Whisper.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:gap-4">
                    {/* Parakeet Live Card */}
                    <div
                        className={`space-y-3 rounded-xl p-4 transition-all ${installedParakeetModel && !isSavingLive ? 'cursor-pointer' : ''} ${uiProvider === 'parakeet'
                            ? 'border-2 border-blue-600 dark:border-blue-400 bg-blue-50/90 dark:bg-blue-950/40 ring-2 ring-blue-500/30 dark:ring-blue-400/30 shadow-md'
                            : 'border-2 border-slate-200 dark:border-slate-700/80 bg-slate-50/70 dark:bg-[#151922] hover:border-blue-400/80 dark:hover:border-blue-500/70 hover:bg-slate-100/80 dark:hover:bg-[#1c2333]'}`}
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
                                <Zap className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h4 className="font-semibold text-slate-900 dark:text-slate-100">Parakeet</h4>
                                        <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                                            Recommended for live
                                        </span>
                                    </div>
                                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                                        Best for live meetings: ultra-low latency, light resource use, and strong real-time accuracy. Runs offline via ONNX.
                                    </p>
                                </div>
                            </div>
                            {uiProvider === 'parakeet' ? (
                                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/50 bg-blue-500/20 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300 shadow-sm">
                                    <CheckCircle2 className="h-3.5 w-3.5" /> Selected for live
                                </span>
                            ) : installedParakeetModel ? (
                                <span className="inline-flex shrink-0 items-center rounded-full border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                                    Click to select
                                </span>
                            ) : (
                                <span className="text-xs text-slate-500 dark:text-slate-400">Download below</span>
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

                    {/* Whisper Live Card */}
                    <div
                        className={`space-y-3 rounded-xl p-4 transition-all ${liveWhisperModel && !isSavingLive ? 'cursor-pointer' : ''} ${uiProvider === 'localWhisper'
                            ? 'border-2 border-blue-600 dark:border-blue-400 bg-blue-50/90 dark:bg-blue-950/40 ring-2 ring-blue-500/30 dark:ring-blue-400/30 shadow-md'
                            : 'border-2 border-slate-200 dark:border-slate-700/80 bg-slate-50/70 dark:bg-[#151922] hover:border-blue-400/80 dark:hover:border-blue-500/70 hover:bg-slate-100/80 dark:hover:bg-[#1c2333]'}`}
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
                                <Languages className="mt-0.5 h-5 w-5 shrink-0 text-violet-500 dark:text-violet-400" />
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h4 className="font-semibold text-slate-900 dark:text-slate-100">Whisper</h4>
                                        <span className="rounded-full bg-violet-500/15 border border-violet-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                                            Better for post-call
                                        </span>
                                    </div>
                                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                                        Best as a post-call second pass. Whisper is heavier during live recording, but supports vocabulary hints, manual language selection, and broad multilingual transcription.
                                    </p>
                                </div>
                            </div>
                            {uiProvider === 'localWhisper' ? (
                                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/50 bg-blue-500/20 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300 shadow-sm">
                                    <CheckCircle2 className="h-3.5 w-3.5" /> Selected for live
                                </span>
                            ) : liveWhisperModel ? (
                                <span className="inline-flex shrink-0 items-center rounded-full border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                                    Click to select
                                </span>
                            ) : null}
                        </div>
                        {liveWhisperModel ? (
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Uses Whisper: <strong className="text-slate-800 dark:text-slate-200">{liveWhisperModel.name}</strong>. Change the installed model under Manage Whisper models below.
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
                </div>
            </section>

            {/* Post-call Retranscription Section */}
            <section ref={postCallSectionRef} className="scroll-mt-6 space-y-4 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1218] p-4 text-slate-900 dark:text-slate-100 shadow-sm sm:p-5">
                <div className="flex items-start gap-3">
                    <Clock3 className="mt-0.5 h-5 w-5 shrink-0 text-violet-500" />
                    <div className="min-w-0 flex-1">
                        <h3 className="font-semibold text-base text-slate-900 dark:text-slate-100">Post-call retranscription</h3>
                        <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                            Choose the default engine for automatic enhancement after recording completes. You can override this for each individual meeting.
                        </p>
                    </div>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:gap-4">
                    {/* Whisper Post-call Card */}
                    <div
                        className={`space-y-3 rounded-xl p-4 transition-all ${postCallWhisperModel && !isLoadingPostCall && !isSavingPostCall ? 'cursor-pointer' : ''} ${effectivePostCallProvider === 'whisper'
                            ? 'border-2 border-blue-600 dark:border-blue-400 bg-blue-50/90 dark:bg-blue-950/40 ring-2 ring-blue-500/30 dark:ring-blue-400/30 shadow-md'
                            : 'border-2 border-slate-200 dark:border-slate-700/80 bg-slate-50/70 dark:bg-[#151922] hover:border-blue-400/80 dark:hover:border-blue-500/70 hover:bg-slate-100/80 dark:hover:bg-[#1c2333]'}`}
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
                                <Languages className="mt-0.5 h-5 w-5 shrink-0 text-violet-500 dark:text-violet-400" />
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h4 className="font-semibold text-slate-900 dark:text-slate-100">Whisper</h4>
                                        <span className="rounded-full bg-violet-500/15 border border-violet-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
                                            Recommended for post-call
                                        </span>
                                        <span className="rounded-full bg-blue-500/15 border border-blue-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-300">
                                            Vocabulary hints
                                        </span>
                                    </div>
                                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                                        High fidelity second pass. Supports custom vocabulary hints to recognize company names, acronyms, and technical terms.
                                    </p>
                                </div>
                            </div>
                            {effectivePostCallProvider === 'whisper' ? (
                                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/50 bg-blue-500/20 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300 shadow-sm">
                                    <CheckCircle2 className="h-3.5 w-3.5" /> Selected for post-call
                                </span>
                            ) : postCallWhisperModel ? (
                                <span className="inline-flex shrink-0 items-center rounded-full border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                                    Click to select
                                </span>
                            ) : null}
                        </div>
                        {postCallWhisperModel ? (
                            <p className="text-xs text-slate-500 dark:text-slate-400">
                                Uses Whisper: <strong className="text-slate-800 dark:text-slate-200">{postCallWhisperModel.name}</strong>. Change specific model under Manage Whisper models below.
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

                    {/* Parakeet Post-call Card */}
                    <div
                        className={`space-y-3 rounded-xl p-4 transition-all ${installedParakeetModel && !isLoadingPostCall && !isSavingPostCall ? 'cursor-pointer' : ''} ${effectivePostCallProvider === 'parakeet'
                            ? 'border-2 border-blue-600 dark:border-blue-400 bg-blue-50/90 dark:bg-blue-950/40 ring-2 ring-blue-500/30 dark:ring-blue-400/30 shadow-md'
                            : 'border-2 border-slate-200 dark:border-slate-700/80 bg-slate-50/70 dark:bg-[#151922] hover:border-blue-400/80 dark:hover:border-blue-500/70 hover:bg-slate-100/80 dark:hover:bg-[#1c2333]'}`}
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
                                <Zap className="mt-0.5 h-5 w-5 shrink-0 text-amber-500" />
                                <div>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <h4 className="font-semibold text-slate-900 dark:text-slate-100">Parakeet</h4>
                                        <span className="rounded-full bg-emerald-500/15 border border-emerald-500/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                                            Fast and accurate
                                        </span>
                                    </div>
                                    <p className="mt-1 text-sm text-slate-600 dark:text-slate-300 leading-relaxed">
                                        Finishes post-call enhancement rapidly using minimal CPU/GPU resources. Does not use global vocabulary hints.
                                    </p>
                                </div>
                            </div>
                            {effectivePostCallProvider === 'parakeet' ? (
                                <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-blue-500/50 bg-blue-500/20 px-2.5 py-1 text-xs font-semibold text-blue-700 dark:text-blue-300 shadow-sm">
                                    <CheckCircle2 className="h-3.5 w-3.5" /> Selected for post-call
                                </span>
                            ) : installedParakeetModel ? (
                                <span className="inline-flex shrink-0 items-center rounded-full border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 px-3 py-1 text-xs font-medium text-slate-700 dark:text-slate-200 hover:border-blue-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors">
                                    Click to select
                                </span>
                            ) : (
                                <span className="text-xs text-slate-500 dark:text-slate-400">Install Parakeet above</span>
                            )}
                        </div>
                    </div>
                </div>

                <div className="min-h-5 text-xs">
                    {postCallError ? (
                        <span className="text-red-500">{postCallError}</span>
                    ) : postCallSaved ? (
                        <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium"><Check className="h-3.5 w-3.5" /> Post-call default saved</span>
                    ) : postCallConfig.provider === 'live' ? (
                        <span className="text-slate-500 dark:text-slate-400">This currently follows your live model. Choosing any card makes post-call selection independent.</span>
                    ) : null}
                </div>

                {/* Whisper Model Manager collapsible */}
                <details
                    open={whisperManagerOpen}
                    onToggle={(event) => setWhisperManagerOpen(event.currentTarget.open)}
                    className="group rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-[#151922] transition-colors"
                >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3.5 text-sm font-semibold text-slate-900 dark:text-slate-100">
                        <span className="flex items-center gap-2">
                            <Languages className="h-4 w-4 text-violet-500 dark:text-violet-400" />
                            Install or manage Whisper models
                        </span>
                        <ChevronDown className="h-4 w-4 text-slate-400 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className={`border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1218] px-4 py-4 rounded-b-xl ${isSavingPostCall ? 'pointer-events-none opacity-70' : ''}`}>
                        <ModelManager
                            selectedModel={effectivePostCallProvider === 'whisper' ? effectivePostCallModel : undefined}
                            onModelSelect={handlePostCallWhisperSelect}
                            autoSave={false}
                        />
                    </div>
                </details>
            </section>

            {/* Vocabulary Hints Section */}
            <section className={`space-y-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0f1218] p-4 text-slate-900 dark:text-slate-100 shadow-sm sm:p-5 ${whisperIsActive ? '' : 'opacity-70'}`}>
                <div className="flex items-start gap-3">
                    <BookOpen className={`mt-0.5 h-4 w-4 shrink-0 ${whisperIsActive ? 'text-blue-500' : 'text-slate-400'}`} />
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <Label htmlFor="whisper-vocabulary" className="text-sm font-semibold text-slate-900 dark:text-slate-100">Global vocabulary hints</Label>
                            {!whisperIsActive && (
                                <span className="rounded-full border border-slate-300 dark:border-slate-700 bg-slate-100 dark:bg-slate-800 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-600 dark:text-slate-400">Whisper only</span>
                            )}
                        </div>
                        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">
                            {whisperIsActive
                                ? 'Help Whisper recognize names, companies, products, acronyms, and technical terms in live or post-call transcription. Whisper uses up to 224 prompt tokens.'
                                : 'These hints become available when Whisper is selected for live or post-call transcription.'}
                        </p>
                    </div>
                </div>
                <Textarea
                    id="whisper-vocabulary"
                    value={vocabulary}
                    onChange={(event) => {
                        vocabularyRevisionRef.current += 1;
                        setVocabulary(event.target.value);
                        setVocabularySaved(false);
                        setVocabularyError(null);
                    }}
                    maxLength={1000}
                    rows={4}
                    disabled={isSavingVocabulary || !whisperIsActive}
                    placeholder={'Meetily\nTauri\nKubernetes\nOKR'}
                    className="resize-y border-slate-200 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50"
                />
                <div className="flex items-center justify-between gap-3">
                    <div className="min-h-5 text-xs">
                        {vocabularyError ? (
                            <span className="text-red-500">{vocabularyError}</span>
                        ) : vocabularySaved ? (
                            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium"><Check className="h-3.5 w-3.5" /> Saved</span>
                        ) : (
                            <span className="text-slate-500 dark:text-slate-400">{vocabulary.length}/1000 characters</span>
                        )}
                    </div>
                    <Button type="button" size="sm" onClick={saveVocabulary} disabled={isSavingVocabulary || !whisperIsActive}>
                        {isSavingVocabulary && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save vocabulary
                    </Button>
                </div>
            </section>
        </div>
    );
}
