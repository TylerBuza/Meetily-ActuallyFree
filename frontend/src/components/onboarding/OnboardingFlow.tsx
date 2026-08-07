import React, { useEffect } from 'react';
import { useOnboarding } from '@/contexts/OnboardingContext';
import {
  WelcomeStep,
  DownloadProgressStep,
  SetupOverviewStep,
  YourNameStep,
  AudioTestStep,
} from './steps';

interface OnboardingFlowProps {
  onComplete: () => void;
}

export function OnboardingFlow({ onComplete }: OnboardingFlowProps) {
  const { currentStep } = useOnboarding();

  // 5-step onboarding:
  // 1 Welcome · 2 Setup · 3 Download models · 4 Your name · 5 Audio test (finish)
  useEffect(() => {
    // Keep prop for API compatibility with layout
    void onComplete;
  }, [onComplete]);

  return (
    <div className="onboarding-flow">
      {currentStep === 1 && <WelcomeStep />}
      {currentStep === 2 && <SetupOverviewStep />}
      {currentStep === 3 && <DownloadProgressStep />}
      {currentStep === 4 && <YourNameStep />}
      {currentStep === 5 && <AudioTestStep />}
    </div>
  );
}
