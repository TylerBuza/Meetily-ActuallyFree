export type WhisperBackend = 'CUDA' | 'Vulkan' | 'Metal' | 'HIP BLAS' | 'CPU';

export interface TranscriptionAccelerationStatus {
  cuda?: boolean;
  vulkan?: boolean;
  sttBackend?: string;
}

export interface CudaReconfigurationStatus {
  compiledBackend: string;
  nvidiaGpuDetected: boolean;
  driverState:
    | 'not-applicable'
    | 'missing-driver'
    | 'outdated-driver'
    | 'unsupported-gpu'
    | 'query-failed'
    | 'ready';
  driverUpdateRequired: boolean;
  reconfigurationRequired: boolean;
  setupDownloadUrl: string | null;
}

export function getWhisperBackend(
  status?: TranscriptionAccelerationStatus | null,
): WhisperBackend | null {
  if (!status) return null;

  switch (status.sttBackend?.trim().toLowerCase()) {
    case 'cuda':
      return 'CUDA';
    case 'vulkan':
      return 'Vulkan';
    case 'metal':
      return 'Metal';
    case 'hipblas':
    case 'hip blas':
      return 'HIP BLAS';
    case 'cpu':
      return 'CPU';
    default:
      if (status.cuda) return 'CUDA';
      if (status.vulkan) return 'Vulkan';
      return 'CPU';
  }
}

export function formatWhisperBackend(backend: WhisperBackend): string {
  switch (backend) {
    case 'CUDA':
      return 'NVIDIA CUDA';
    case 'Vulkan':
      return 'Vulkan GPU';
    case 'Metal':
      return 'Apple Metal';
    case 'HIP BLAS':
      return 'AMD HIP';
    case 'CPU':
      return 'CPU';
  }
}
