'use client';

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { toast } from 'sonner';
import { activateOptionalModel, OPTIONAL_MODEL_PREFERENCES_CHANGED } from '@/lib/optional-model-activation';

export const OPTIONAL_WHISPER_MODEL = 'large-v3-turbo-q5_0';
export type OptionalModel = 'whisper' | 'nemotron';
export type OptionalDownload = { status: 'idle' | 'downloading' | 'activating' | 'ready' | 'error' | 'activation-error'; progress: number; error?: string; enabled?: boolean };
type Jobs = Record<OptionalModel, OptionalDownload>;
const initialJobs: Jobs = {
  whisper: { status: 'idle', progress: 0 }, nemotron: { status: 'idle', progress: 0 },
};
const Context = createContext<{ jobs: Jobs; startDownload: (model: OptionalModel) => void } | null>(null);

/** App-level owner: leaving onboarding or navigating never cancels these jobs. */
export function OptionalModelDownloadsProvider({ children }: { children: React.ReactNode }) {
  const [jobs, setJobs] = useState<Jobs>(initialJobs);
  const active = useRef(new Set<OptionalModel>());
  const whisperCompletion = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const listenersReady = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const update = useCallback((model: OptionalModel, job: OptionalDownload) => {
    if (mounted.current) setJobs(previous => ({ ...previous, [model]: job }));
  }, []);

  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    const unsubscribers: UnlistenFn[] = [];
    async function register<T>(name: string, callback: (payload: T) => void) {
      const stop = await listen<T>(name, event => { if (!disposed) callback(event.payload); });
      if (disposed) stop(); else unsubscribers.push(stop);
    }
    listenersReady.current = Promise.all([
      register<{ modelName: string; progress: number }>('model-download-progress', p => {
        if (p.modelName === OPTIONAL_WHISPER_MODEL) update('whisper', { status: 'downloading', progress: p.progress });
      }),
      register<{ modelName: string }>('model-download-complete', p => {
        if (p.modelName === OPTIONAL_WHISPER_MODEL) {
          update('whisper', { status: 'ready', progress: 100 });
          whisperCompletion.current?.resolve();
        }
      }),
      register<{ modelName: string; error: string }>('model-download-error', p => {
        if (p.modelName === OPTIONAL_WHISPER_MODEL) {
          update('whisper', { status: 'error', progress: 0, error: p.error });
          whisperCompletion.current?.reject(new Error(p.error));
        }
      }),
      register<{ file: string; percent: number; status: string; message?: string }>('diarization-download-progress', p => {
        if (p.file === 'nemotron3_diar_v3.onnx' || p.file === 'Nemotron-LICENSE.txt' || p.message?.startsWith('Nemotron-3')) {
          update('nemotron', { status: p.status === 'done' && p.file === '' ? 'ready' : 'downloading', progress: p.percent });
        }
      }),
    ]).then(() => undefined);
    // No download starts automatically: these checks only restore installed status.
    void Promise.all([
      invoke<Array<{ name: string; status: unknown }>>('whisper_get_available_models'),
      invoke<{ provider: string; model: string }>('api_get_post_call_transcript_config'),
    ]).then(([models, config]) => {
      if (disposed || active.current.has('whisper')) return;
      const model = models.find(m => m.name === OPTIONAL_WHISPER_MODEL);
      if (model?.status === 'Available') update('whisper', { status: 'ready', progress: 100, enabled: config.provider === 'whisper' && config.model === OPTIONAL_WHISPER_MODEL });
      else if (model?.status && typeof model.status === 'object' && 'Downloading' in model.status) {
        update('whisper', { status: 'downloading', progress: Number(model.status.Downloading) || 0 });
      }
    }).catch(() => {});
    void invoke<{ nemotron_available: boolean; active_engine: string }>('diarization_get_status').then(status => {
      if (!disposed && !active.current.has('nemotron') && status.nemotron_available) update('nemotron', { status: 'ready', progress: 100, enabled: status.active_engine === 'nemotron' });
    }).catch(() => {});
    void listenersReady.current.catch(error => console.error('Optional model progress listeners unavailable:', error));
    const refreshEnabled = () => {
      void Promise.all([
        invoke<{ active_engine: string }>('diarization_get_status'),
        invoke<{ provider: string; model: string }>('api_get_post_call_transcript_config'),
      ]).then(([diarization, postCall]) => {
        if (disposed) return;
        setJobs(previous => ({
          whisper: { ...previous.whisper, enabled: postCall.provider === 'whisper' && postCall.model === OPTIONAL_WHISPER_MODEL },
          nemotron: { ...previous.nemotron, enabled: diarization.active_engine === 'nemotron' },
        }));
      }).catch(() => {});
    };
    if (typeof window !== 'undefined') window.addEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshEnabled);
    return () => {
      disposed = true; mounted.current = false; unsubscribers.forEach(stop => stop());
      if (typeof window !== 'undefined') window.removeEventListener(OPTIONAL_MODEL_PREFERENCES_CHANGED, refreshEnabled);
    };
  }, [update]);

  const startDownload = useCallback((model: OptionalModel) => {
    if (active.current.has(model)) return;
    active.current.add(model);
    update(model, { status: 'downloading', progress: 0 });
    let downloaded = false;
    // Intentionally detached from navigation: only native completion settles this job.
    void (async () => {
      await listenersReady.current;
      if (model === 'whisper') {
        // Subscribe before querying state, so completion of an existing native
        // download cannot be missed between the status query and waiting.
        const completed = new Promise<void>((resolve, reject) => { whisperCompletion.current = { resolve, reject }; });
        void completed.catch(() => {});
        const models = await invoke<Array<{ name: string; status: unknown }>>('whisper_get_available_models');
        const existing = models.find(m => m.name === OPTIONAL_WHISPER_MODEL);
        if (existing?.status && typeof existing.status === 'object' && 'Downloading' in existing.status) await completed;
        else if (existing?.status !== 'Available') await invoke('whisper_download_model', { modelName: OPTIONAL_WHISPER_MODEL });
      } else {
        await invoke('download_diarization_models', { engine: 'nemotron' });
      }
      downloaded = true;
      update(model, { status: 'activating', progress: 100 });
      await activateOptionalModel(model, OPTIONAL_WHISPER_MODEL);
      update(model, { status: 'ready', progress: 100, enabled: true });
      toast.success(`${model === 'whisper' ? 'Whisper' : 'Nemotron'} is enabled`, { description: model === 'whisper' ? 'Whisper is now the default for post-call enhancement and retranscription.' : 'Nemotron will auto-detect speakers after recording.' });
    })().catch(error => {
      update(model, { status: downloaded ? 'activation-error' : 'error', progress: downloaded ? 100 : 0, error: String(error) });
      toast.error(downloaded ? 'Model downloaded, but could not enable it' : `${model === 'whisper' ? 'Whisper' : 'Nemotron'} download failed`, { description: 'You can keep using Meetily and retry from Settings.' });
    }).finally(() => {
      active.current.delete(model);
      if (model === 'whisper') whisperCompletion.current = null;
    });
  }, [update]);

  return <Context.Provider value={{ jobs, startDownload }}>{children}</Context.Provider>;
}

export function useOptionalModelDownloads() {
  const value = useContext(Context);
  if (!value) throw new Error('OptionalModelDownloadsProvider is required');
  return value;
}
