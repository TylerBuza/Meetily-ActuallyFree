import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AlertTriangle, Cpu, Info, RefreshCw, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  formatWhisperBackend,
  getWhisperBackend,
  type CudaReconfigurationStatus,
  type TranscriptionAccelerationStatus,
  type WhisperBackend,
} from '@/lib/transcription-acceleration';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { useOptionalModelDownloads } from '@/contexts/OptionalModelDownloadsContext';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function SetupOverviewStep() {
  const { goNext } = useOnboarding();
  const { jobs, startDownload } = useOptionalModelDownloads();
  const [installWhisper, setInstallWhisper] = useState(false);
  const [installNemotron, setInstallNemotron] = useState(false);
  const [isMac, setIsMac] = useState(false);
  const [whisperBackend, setWhisperBackend] = useState<WhisperBackend | null | undefined>();
  const [cudaStatus, setCudaStatus] = useState<CudaReconfigurationStatus | null>(null);
  const [checkingAcceleration, setCheckingAcceleration] = useState(false);

  const checkAcceleration = async () => {
    setCheckingAcceleration(true);
    try {
      const [status, cuda] = await Promise.all([
        invoke<TranscriptionAccelerationStatus>('get_local_stack_status'),
        invoke<CudaReconfigurationStatus>('get_cuda_reconfiguration_status'),
      ]);
      setWhisperBackend(getWhisperBackend(status));
      setCudaStatus(cuda);
    } catch (error) {
      console.error('Failed to detect transcription acceleration:', error);
      setWhisperBackend(null);
      setCudaStatus(null);
    } finally {
      setCheckingAcceleration(false);
    }
  };

  useEffect(() => {
    const checkPlatform = async () => {
      try {
        const { platform } = await import('@tauri-apps/plugin-os');
        setIsMac(platform() === 'macos');
      } catch (e) {
        setIsMac(navigator.userAgent.includes('Mac'));
      }
    };
    checkPlatform();
    void checkAcceleration();
  }, []);

  const steps = [
    {
      number: 1,
      type: 'transcription',
      title: 'Download Transcription Engine',
    },
    {
      number: 2,
      type: 'summarization',
      title: 'Download Summarization Engine',
    },
  ];

  const handleContinue = () => {
    if (installWhisper) startDownload('whisper');
    if (installNemotron) startDownload('nemotron');
    goNext();
  };

  const openIssues = () => {
    invoke('open_external_url', {
      url: 'https://github.com/TylerBuza/Meetily-ActuallyFree',
    }).catch((error) => console.error('Failed to open GitHub issues:', error));
  };

  const openNvidiaDrivers = () => {
    invoke('open_external_url', {
      url: 'https://www.nvidia.com/Download/index.aspx',
    }).catch((error) => console.error('Failed to open NVIDIA drivers:', error));
  };

  const openLatestSetup = () => {
    if (!cudaStatus?.setupDownloadUrl) return;
    invoke('open_external_url', {
      url: cudaStatus.setupDownloadUrl,
    }).catch((error) => console.error('Failed to open latest Meetily setup:', error));
  };

  const accelerationLabel = cudaStatus?.reconfigurationRequired
    ? 'NVIDIA CUDA available — setup required'
    : whisperBackend === undefined
    ? 'Detecting...'
    : whisperBackend === null
      ? 'Could not determine'
      : `${formatWhisperBackend(whisperBackend)} selected`;
  const accelerationDescription = whisperBackend === undefined
    ? 'Checking the acceleration selected for this installation.'
    : whisperBackend === null
      ? 'You can review the acceleration backend later in Local Stack settings.'
      : whisperBackend === 'CPU'
        ? 'Whisper post-call enhancement will use CPU processing.'
        : 'Whisper post-call enhancement will use this automatically selected backend.';
  const showCudaNotice = cudaStatus?.driverUpdateRequired || cudaStatus?.reconfigurationRequired;
  const cudaProbeFailed = cudaStatus?.driverState === 'query-failed';
  const cudaBuildInstalled = cudaStatus?.compiledBackend.toLowerCase() === 'cuda';

  return (
    <OnboardingContainer
      title="Setup Overview"
      description="Meetily requires that you download the Transcription & Summarization AI models for the software to work."
      step={2}
      totalSteps={isMac ? 4 : 3}
    >
      <div className="flex flex-col items-center space-y-10">
        {/* Steps Card */}
        <div className="w-full max-w-md bg-af-panel rounded-lg border border-af-border p-4">
          <div className="space-y-4">
            {steps.map((step) => {
              return (
                <div
                  key={step.number}
                  className="flex items-start gap-4 p-1"
                >
                  <div className="flex-1 ml-1">
                    <h3 className="font-medium text-af-text flex items-center gap-2">
                        Step {step.number} :  {step.title}

                        {step.type === 'summarization' && (
                            <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                <button className="text-af-text-4 hover:text-af-text-2">
                                    <Info className="w-4 h-4" />
                                </button>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs text-sm">
                                You can also select external AI providers like OpenAI, Claude, or
                                Ollama for summary generation in settings.
                                </TooltipContent>
                            </Tooltip>
                            </TooltipProvider>
                        )}
                        </h3>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="w-full max-w-md rounded-lg border border-af-border bg-af-panel p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-af-accent/10 p-2 text-af-accent">
              {whisperBackend === 'CPU' ? <Cpu className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-af-text">Transcription acceleration</p>
              <p className="mt-1 text-sm font-semibold text-af-accent">
                {accelerationLabel}
              </p>
              <p className="mt-1 text-xs leading-5 text-af-text-2">
                {accelerationDescription} Live Parakeet uses the CPU by default; DirectML acceleration is optional in Labs.
              </p>
            </div>
          </div>
        </div>

        {showCudaNotice && (
          <div
            role="status"
            className="w-full max-w-md rounded-lg border border-af-warning/35 bg-af-warning/10 p-4 text-af-text"
          >
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-af-warning" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {cudaStatus?.reconfigurationRequired
                    ? 'CUDA is ready now'
                    : cudaProbeFailed
                      ? 'CUDA support could not be verified'
                      : 'Your NVIDIA GPU needs a current driver'}
                </p>
                <p className="mt-1 text-xs leading-5 text-af-text">
                  {cudaStatus?.reconfigurationRequired
                    ? `This installation is still using ${formatWhisperBackend(whisperBackend ?? 'CPU')}. Rerun the latest Meetily setup and it will select NVIDIA CUDA automatically.`
                    : cudaProbeFailed
                      ? `Meetily could not read your NVIDIA driver details. Update or reinstall the driver, then recheck here.${cudaBuildInstalled ? '' : ' The current backend remains selected until setup is rerun.'}`
                      : cudaBuildInstalled
                        ? 'This CUDA installation cannot use acceleration until NVIDIA driver 580.00 or newer is installed.'
                        : 'Install NVIDIA driver 580.00 or newer to enable CUDA acceleration. Meetily will keep using its current fallback safely until you rerun setup.'}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={cudaStatus?.reconfigurationRequired ? openLatestSetup : openNvidiaDrivers}
                    className="border-af-warning/35 bg-af-panel text-af-text hover:bg-af-warning/10"
                  >
                    {cudaStatus?.reconfigurationRequired ? 'Download CUDA setup' : 'Get NVIDIA driver'}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={checkingAcceleration}
                    onClick={() => void checkAcceleration()}
                    className="text-af-text hover:bg-af-warning/10"
                  >
                    <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checkingAcceleration ? 'animate-spin' : ''}`} />
                    Recheck
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="w-full max-w-md space-y-3 rounded-lg border border-af-border bg-af-panel p-4 text-af-text">
          <h3 className="text-sm font-medium">Optional upgrades</h3>
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <Checkbox checked={installWhisper} onCheckedChange={checked => setInstallWhisper(checked === true)} className="mt-0.5" />
            <span>Whisper for retranscription <span className="rounded-full bg-af-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-af-accent">Recommended</span> <span className="text-af-text-3">{jobs.whisper.status === 'ready' ? '· Installed; enable it' : '· ~547 MB'}</span>
              <span className="mt-0.5 block text-xs leading-5 text-af-text-2">Large v3 Turbo Q5 for post-call enhancement and retranscribing recordings. Parakeet remains the live transcription engine.</span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <Checkbox checked={installNemotron} onCheckedChange={checked => setInstallNemotron(checked === true)} className="mt-0.5" />
            <span>Nemotron for speaker identification <span className="rounded-full bg-af-accent/10 px-1.5 py-0.5 text-[11px] font-medium text-af-accent">Recommended</span> <span className="text-af-text-3">{jobs.nemotron.status === 'ready' ? '· Installed; enable it' : '· ~382 MB'}</span>
              <span className="mt-0.5 block text-xs leading-5 text-af-text-2">Auto-detect speakers after recording. Windows supports DirectML GPU acceleration with CPU fallback.</span>
            </span>
          </label>
          <p className="text-xs leading-5 text-af-text-3">Selected models download in the background and enable automatically when ready. You can finish setup immediately and track progress or retry in Settings.</p>
        </div>

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-4">
          <Button
            onClick={handleContinue}
            className="w-full h-11 bg-af-elevated hover:bg-af-elevated text-white"
          >
            Let's Go
          </Button>
          <div className="text-center">
            <button
              type="button"
              onClick={openIssues}
              className="text-xs text-af-text-2 hover:underline"
            >
              View project on GitHub
            </button>
          </div>
        </div>
      </div>
    </OnboardingContainer>
  );
}
