import { invoke } from '@tauri-apps/api/core';

export interface QwenModelInfo {
  name: string;
  display_name: string;
  path: string;
  size_mb: number;
  accuracy: string;
  speed: string;
  status: 'Available' | 'Missing' | 'Downloading' | string;
  description: string;
  recommended_for: 'live' | 'post-call';
}

export interface QwenDownloadProgress {
  modelName: string;
  downloaded_bytes: number;
  total_bytes: number;
  downloaded_mb: number;
  total_mb: number;
  percent: number;
  speed_mbps: number;
  status: 'downloading' | 'completed' | 'cancelled' | 'error';
}

export class QwenAPI {
  static async getAvailableModels(): Promise<QwenModelInfo[]> {
    try {
      return await invoke<QwenModelInfo[]>('qwen_get_available_models');
    } catch (e) {
      console.warn('Failed to fetch Qwen models from Tauri:', e);
      // Fallback defaults for browser/offline mode
      return [
        {
          name: 'Qwen3-ASR-0.6B',
          display_name: 'Qwen3-ASR 0.6B',
          path: '',
          size_mb: 745,
          accuracy: 'High (0.6B params)',
          speed: 'Ultra Fast (2000x RT)',
          status: 'Available',
          description:
            'Optimized for real-time live recording & low latency. Up to 2000x real-time throughput across 52 languages.',
          recommended_for: 'live',
        },
        {
          name: 'Qwen3-ASR-1.7B',
          display_name: 'Qwen3-ASR 1.7B',
          path: '',
          size_mb: 1270,
          accuracy: 'State-of-the-Art (1.7B params)',
          speed: 'Fast (600x RT)',
          status: 'Available',
          description:
            'State-of-the-art multilingual accuracy for noisy speech, strong accents, multi-speaker dialogue, and 22 dialects.',
          recommended_for: 'post-call',
        },
      ];
    }
  }

  static async downloadModel(modelName: string): Promise<void> {
    await invoke('qwen_download_model', { modelName });
  }

  static async cancelDownload(modelName: string): Promise<boolean> {
    return await invoke<boolean>('qwen_cancel_download', { modelName });
  }

  static async deleteModel(modelName: string): Promise<boolean> {
    return await invoke<boolean>('qwen_delete_model', { modelName });
  }

  static async openModelsFolder(): Promise<void> {
    await invoke('open_qwen_models_folder');
  }
}
