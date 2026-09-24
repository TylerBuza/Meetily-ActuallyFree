"use client"

import React, { useState, useEffect, useRef } from 'react';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { motion, AnimatePresence } from 'framer-motion';
import { toast } from 'sonner';
import {
  Sparkles,
  Check,
  CheckCircle2,
  Cpu,
  Globe,
  Zap,
  Download,
  Trash2,
  XCircle,
  FolderOpen,
  ExternalLink,
  Loader2,
} from 'lucide-react';
import { Button } from './ui/button';
import { QwenAPI, QwenModelInfo, QwenDownloadProgress } from '@/lib/qwen';

interface QwenModelManagerProps {
  selectedModel?: string;
  onModelSelect?: (modelName: string) => void | boolean | Promise<void | boolean>;
  autoSave?: boolean;
  mode?: 'live' | 'post-call' | 'both';
  showFooterBanner?: boolean;
}

export function QwenModelManager({
  selectedModel,
  onModelSelect,
  mode = 'both',
  showFooterBanner = true,
}: QwenModelManagerProps) {
  const [models, setModels] = useState<QwenModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeDownloads, setActiveDownloads] = useState<Record<string, QwenDownloadProgress>>({});
  const [selected, setSelected] = useState<string>(selectedModel || 'Qwen3-ASR-0.6B');
  const [hoveredModel, setHoveredModel] = useState<string | null>(null);

  const unlistenProgressRef = useRef<UnlistenFn | null>(null);
  const unlistenCompleteRef = useRef<UnlistenFn | null>(null);

  // Sync selected prop
  useEffect(() => {
    if (selectedModel) {
      setSelected(selectedModel);
    }
  }, [selectedModel]);

  // Load models
  const refreshModels = async () => {
    try {
      setLoading(true);
      const list = await QwenAPI.getAvailableModels();
      setModels(list);
    } catch (e) {
      console.error('Failed to load Qwen models:', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshModels();

    const setupListeners = async () => {
      unlistenProgressRef.current = await listen<QwenDownloadProgress>(
        'qwen-model-download-progress',
        (event) => {
          const payload = event.payload;
          setActiveDownloads((prev) => {
            if (payload.status === 'completed' || payload.status === 'cancelled') {
              const updated = { ...prev };
              delete updated[payload.modelName];
              return updated;
            }
            return {
              ...prev,
              [payload.modelName]: payload,
            };
          });

          if (payload.status === 'completed') {
            refreshModels();
          }
        }
      );

      unlistenCompleteRef.current = await listen<{ modelName: string }>(
        'qwen-model-download-complete',
        (event) => {
          setActiveDownloads((prev) => {
            const updated = { ...prev };
            delete updated[event.payload.modelName];
            return updated;
          });
          toast.success(`Qwen3-ASR model installed: ${event.payload.modelName}`);
          refreshModels();
          if (onModelSelect) {
            onModelSelect(event.payload.modelName);
          }
        }
      );
    };

    setupListeners();

    return () => {
      if (unlistenProgressRef.current) unlistenProgressRef.current();
      if (unlistenCompleteRef.current) unlistenCompleteRef.current();
    };
  }, [onModelSelect]);

  const handleSelect = async (modelName: string) => {
    setSelected(modelName);
    if (onModelSelect) {
      await onModelSelect(modelName);
    }
  };

  const handleDownload = async (modelName: string) => {
    try {
      toast.info(`Starting download for ${modelName}…`);
      await QwenAPI.downloadModel(modelName);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(`Download failed: ${msg}`);
      setActiveDownloads((prev) => {
        const updated = { ...prev };
        delete updated[modelName];
        return updated;
      });
    }
  };

  const handleCancelDownload = async (modelName: string) => {
    try {
      await QwenAPI.cancelDownload(modelName);
      setActiveDownloads((prev) => {
        const updated = { ...prev };
        delete updated[modelName];
        return updated;
      });
      toast.info(`Download cancelled for ${modelName}`);
    } catch (e) {
      toast.error('Failed to cancel download');
    }
  };

  const handleDelete = async (modelName: string) => {
    try {
      await QwenAPI.deleteModel(modelName);
      toast.success(`Deleted ${modelName}`);
      refreshModels();
    } catch (e) {
      toast.error('Failed to delete model');
    }
  };

  const handleOpenFolder = async () => {
    try {
      await QwenAPI.openModelsFolder();
    } catch (e) {
      toast.error('Could not open folder');
    }
  };

  return (
    <div className="space-y-4">
      {/* Model Cards Grid */}
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        {models.map((model) => {
          const isSelected = selected === model.name;
          const isAvailable = model.status === 'Available';
          const downloadProgress = activeDownloads[model.name];
          const isDownloading = !!downloadProgress;

          const isRecommended =
            (mode === 'live' && model.name.includes('0.6B')) ||
            (mode === 'post-call' && model.name.includes('1.7B')) ||
            (mode === 'both' && model.name.includes('0.6B'));

          return (
            <motion.div
              key={model.name}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              onMouseEnter={() => setHoveredModel(model.name)}
              onMouseLeave={() => setHoveredModel(null)}
              onClick={() => {
                if (isAvailable && !isDownloading) {
                  handleSelect(model.name);
                } else if (!isAvailable && !isDownloading) {
                  handleDownload(model.name);
                }
              }}
              className={`relative flex flex-col justify-between rounded-xl p-4 text-left transition-all ${
                !isDownloading ? 'cursor-pointer' : 'cursor-default'
              } ${
                isSelected && isAvailable
                  ? 'border-2 border-purple-600 dark:border-purple-400 bg-purple-50/90 dark:bg-purple-950/40 ring-2 ring-purple-500/30 dark:ring-purple-400/30 shadow-md text-slate-900 dark:text-slate-100'
                  : isAvailable
                  ? 'border-2 border-slate-200 dark:border-slate-700/80 bg-white dark:bg-[#151922] hover:border-purple-400/80 dark:hover:border-purple-500/70 hover:bg-slate-50 dark:hover:bg-[#1c2333] text-slate-800 dark:text-slate-200'
                  : 'border-2 border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-[#11151e] opacity-90 text-slate-800 dark:text-slate-200'
              }`}
            >
              {/* Recommended Badge */}
              {isRecommended && (
                <div className="absolute -top-2.5 right-4 rounded-full bg-purple-600 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white shadow-sm ring-2 ring-white dark:ring-slate-900">
                  {mode === 'live'
                    ? 'Recommended for Live'
                    : mode === 'post-call'
                    ? 'Recommended for Post-call'
                    : 'Recommended'}
                </div>
              )}

              <div>
                {/* Header: Title, Icon, Badge & Action */}
                <div className="flex items-start justify-between gap-2 mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">
                      {model.name.includes('0.6B') ? '⚡' : '🎯'}
                    </span>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="font-bold text-sm text-slate-900 dark:text-white">
                          {model.display_name}
                        </h4>
                        {isSelected && isAvailable && (
                          <span className="flex items-center gap-0.5 rounded-full bg-purple-600 px-2 py-0.5 text-[10px] font-bold text-white shadow-xs">
                            <Check className="h-3 w-3 stroke-[3]" /> Active
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-purple-600 dark:text-purple-400 font-medium">
                        {model.name.includes('0.6B')
                          ? '2000x Real-time • Streaming low-latency'
                          : 'SOTA Multilingual • Accents & Noise'}
                      </span>
                    </div>
                  </div>

                  {/* Status / Action Button on top right */}
                  <div className="flex items-center gap-2">
                    {isAvailable && (
                      <div className="flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-semibold">
                        <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                        Ready
                      </div>
                    )}

                    {isAvailable && hoveredModel === model.name && !isDownloading && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(model.name);
                        }}
                        className="rounded p-1 text-slate-400 hover:bg-red-500/10 hover:text-red-500 transition-colors"
                        title="Delete model to free disk space"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}

                    {!isAvailable && !isDownloading && (
                      <Button
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(model.name);
                        }}
                        className="h-8 gap-1.5 bg-purple-600 hover:bg-purple-700 text-white font-semibold text-xs px-3 shadow-xs"
                      >
                        <Download className="h-3.5 w-3.5" />
                        Download ({model.size_mb} MB)
                      </Button>
                    )}
                  </div>
                </div>

                {/* Description */}
                <p className="text-xs text-slate-600 dark:text-slate-300 leading-relaxed mb-3 mt-1">
                  {model.description}
                </p>

                {/* Model Specs (Speed, Accuracy, Size) */}
                <div className="grid grid-cols-3 gap-2 py-2 px-2.5 rounded-lg bg-slate-100/80 dark:bg-slate-800/60 border border-slate-200/80 dark:border-slate-700/60 text-[11px] mb-3">
                  <div>
                    <span className="text-slate-500 dark:text-slate-400 block text-[10px]">Speed</span>
                    <strong className="text-slate-800 dark:text-slate-200 font-semibold flex items-center gap-1">
                      <Zap className="h-3 w-3 text-amber-500" />
                      {model.speed}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-slate-400 block text-[10px]">Accuracy</span>
                    <strong className="text-slate-800 dark:text-slate-200 font-semibold flex items-center gap-1">
                      <Sparkles className="h-3 w-3 text-purple-500" />
                      {model.accuracy}
                    </strong>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-slate-400 block text-[10px]">Size</span>
                    <strong className="text-slate-800 dark:text-slate-200 font-semibold">
                      ~{model.size_mb} MB
                    </strong>
                  </div>
                </div>

                {/* Download Progress Bar */}
                {isDownloading && downloadProgress && (
                  <div className="space-y-1.5 rounded-lg border border-purple-500/30 bg-purple-500/10 dark:bg-purple-950/30 p-2.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-semibold text-purple-700 dark:text-purple-300 flex items-center gap-1.5">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        Downloading… {downloadProgress.percent}%
                      </span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancelDownload(model.name);
                        }}
                        className="text-slate-400 hover:text-red-500"
                        title="Cancel download"
                      >
                        <XCircle className="h-4 w-4" />
                      </button>
                    </div>

                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                      <div
                        className="h-full bg-purple-600 transition-all duration-150"
                        style={{ width: `${Math.max(2, downloadProgress.percent)}%` }}
                      />
                    </div>

                    <div className="flex justify-between text-[10px] text-slate-500 dark:text-slate-400">
                      <span>
                        {downloadProgress.downloaded_mb.toFixed(1)} MB / {downloadProgress.total_mb.toFixed(1)} MB
                      </span>
                      <span>{downloadProgress.speed_mbps.toFixed(1)} MB/s</span>
                    </div>
                  </div>
                )}
              </div>

              {/* Card Footer */}
              <div className="mt-2.5 pt-2.5 border-t border-slate-200 dark:border-slate-700/80 flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                <span className="flex items-center gap-1">
                  <Globe className="h-3.5 w-3.5 text-purple-500" />
                  52 languages & dialects
                </span>

                {isAvailable ? (
                  isSelected ? (
                    <span className="font-bold text-purple-600 dark:text-purple-400">
                      Selected
                    </span>
                  ) : (
                    <span className="font-medium text-slate-600 dark:text-slate-400 hover:text-purple-600 dark:hover:text-purple-400">
                      Click card to select
                    </span>
                  )
                ) : (
                  <span className="text-amber-600 dark:text-amber-400 font-medium">
                    {isDownloading ? 'Downloading…' : 'Needs download'}
                  </span>
                )}
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* Info & Explorer Link Banner */}
      {showFooterBanner && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/60 p-3 text-xs text-slate-600 dark:text-slate-300">
          <div className="flex items-center gap-2">
            <Globe className="h-4 w-4 text-purple-500 shrink-0" />
            <span>
              Qwen3-ASR models run entirely on-device via ONNX Runtime with CPU and CUDA GPU acceleration.
            </span>
          </div>
          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={handleOpenFolder}
              className="inline-flex items-center gap-1 font-semibold text-purple-600 dark:text-purple-400 hover:underline cursor-pointer"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              Open Folder
            </button>
            <a
              href="https://github.com/QwenLM/Qwen3-ASR"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-semibold text-purple-600 dark:text-purple-400 hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" />
              GitHub
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
