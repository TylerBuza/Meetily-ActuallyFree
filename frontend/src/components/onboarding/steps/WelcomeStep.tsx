import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Lock, Sparkles, Cpu, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';

export function WelcomeStep() {
  const { goNext } = useOnboarding();
  const [checkUpdates, setCheckUpdates] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const features = [
    {
      icon: Lock,
      title: 'Your data never leaves your device',
    },
    {
      icon: Sparkles,
      title: 'Intelligent summaries & insights',
    },
    {
      icon: Cpu,
      title: 'Works offline, no cloud required',
    },
  ];

  const continueOnboarding = async () => {
    if (checkUpdates === null || saving) return;
    setSaving(true);
    try {
      await invoke('set_check_updates_on_launch', { enabled: checkUpdates });
      goNext();
    } catch (error) {
      console.error('Failed to save update preference:', error);
      setSaving(false);
    }
  };

  return (
    <OnboardingContainer
      title="Welcome to Meetily"
      description="Record. Transcribe. Summarize. All on your device."
      step={1}
      hideProgress={true}
    >
      <div className="flex flex-col items-center space-y-6">
        {/* Divider */}
        <div className="w-16 h-px bg-gray-300" />

        {/* Features Card */}
        <div className="w-full max-w-md bg-white rounded-lg border border-gray-200 shadow-sm p-6 space-y-4">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div key={index} className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <div className="w-5 h-5 rounded-full bg-gray-100 flex items-center justify-center">
                    <Icon className="w-3 h-3 text-gray-700" />
                  </div>
                </div>
                <p className="text-sm text-gray-700 leading-relaxed">{feature.title}</p>
              </div>
            );
          })}
        </div>

        <div className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-gray-100">
              <RefreshCw className="h-3.5 w-3.5 text-gray-700" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-gray-900">Check for updates when Meetily starts?</h2>
              <p className="mt-1 text-xs leading-relaxed text-gray-500">
                This checks this fork&apos;s GitHub releases. No analytics or usage data is sent.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setCheckUpdates(true)}
              aria-pressed={checkUpdates === true}
              className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                checkUpdates === true
                  ? 'border-gray-900 bg-gray-900 text-white'
                  : 'border-gray-200 text-gray-700 hover:border-gray-400'
              }`}
            >
              Yes, check on launch
            </button>
            <button
              type="button"
              onClick={() => setCheckUpdates(false)}
              aria-pressed={checkUpdates === false}
              className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                checkUpdates === false
                  ? 'border-gray-900 bg-gray-900 text-white'
                  : 'border-gray-200 text-gray-700 hover:border-gray-400'
              }`}
            >
              No, I&apos;ll check manually
            </button>
          </div>
        </div>

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-3">
          {checkUpdates !== null && (
            <Button
              onClick={() => void continueOnboarding()}
              disabled={saving}
              className="w-full h-11 bg-gray-900 hover:bg-gray-800 text-white"
            >
              {saving ? 'Saving…' : 'Get Started'}
            </Button>
          )}
          <p className="text-xs text-center text-gray-500">Takes less than 3 minutes</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
