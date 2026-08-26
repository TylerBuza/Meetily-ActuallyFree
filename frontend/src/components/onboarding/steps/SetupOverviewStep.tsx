import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Cpu, Info, Zap } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  formatWhisperBackend,
  getWhisperBackend,
  type TranscriptionAccelerationStatus,
  type WhisperBackend,
} from '@/lib/transcription-acceleration';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function SetupOverviewStep() {
  const { goNext } = useOnboarding();
  const [isMac, setIsMac] = useState(false);
  const [whisperBackend, setWhisperBackend] = useState<WhisperBackend | null | undefined>();

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

    invoke<TranscriptionAccelerationStatus>('get_local_stack_status')
      .then((status) => setWhisperBackend(getWhisperBackend(status)))
      .catch((error) => {
        console.error('Failed to detect transcription acceleration:', error);
        setWhisperBackend(null);
      });
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
    goNext();
  };

  const openIssues = () => {
    invoke('open_external_url', {
      url: 'https://github.com/TylerBuza/Meetily-ActuallyFree',
    }).catch((error) => console.error('Failed to open GitHub issues:', error));
  };

  const accelerationLabel = whisperBackend === undefined
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

  return (
    <OnboardingContainer
      title="Setup Overview"
      description="Meetily requires that you download the Transcription & Summarization AI models for the software to work."
      step={2}
      totalSteps={isMac ? 4 : 3}
    >
      <div className="flex flex-col items-center space-y-10">
        {/* Steps Card */}
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 p-4">
          <div className="space-y-4">
            {steps.map((step) => {
              return (
                <div
                  key={step.number}
                  className="flex items-start gap-4 p-1"
                >
                  <div className="flex-1 ml-1">
                    <h3 className="font-medium text-gray-900 flex items-center gap-2">
                        Step {step.number} :  {step.title}

                        {step.type === 'summarization' && (
                            <TooltipProvider>
                            <Tooltip>
                                <TooltipTrigger asChild>
                                <button className="text-gray-400 hover:text-gray-600">
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

        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-full bg-blue-50 p-2 text-blue-600">
              {whisperBackend === 'CPU' ? <Cpu className="h-4 w-4" /> : <Zap className="h-4 w-4" />}
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-gray-900">Transcription acceleration</p>
              <p className="mt-1 text-sm font-semibold text-blue-700">
                {accelerationLabel}
              </p>
              <p className="mt-1 text-xs leading-5 text-gray-600">
                {accelerationDescription} Live Parakeet transcription uses the CPU.
              </p>
            </div>
          </div>
        </div>

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-4">
          <Button
            onClick={handleContinue}
            className="w-full h-11 bg-gray-900 hover:bg-gray-800 text-white"
          >
            Let's Go
          </Button>
          <div className="text-center">
            <button
              type="button"
              onClick={openIssues}
              className="text-xs text-gray-600 hover:underline"
            >
              View project on GitHub
            </button>
          </div>
        </div>
      </div>
    </OnboardingContainer>
  );
}
