import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Lock, Sparkles, Cpu, RefreshCw, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { OnboardingContainer } from '../OnboardingContainer';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { usePlatform } from '@/hooks/usePlatform';
import { useI18n, type MessageKey } from '@/i18n';

export function WelcomeStep() {
  const { goNext } = useOnboarding();
  const platform = usePlatform();
  const { t } = useI18n();
  const updatesSupported = platform !== 'macos';
  const [checkUpdates, setCheckUpdates] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);

  const features: Array<{ icon: LucideIcon; titleKey: MessageKey }> = [
    {
      icon: Lock,
      titleKey: 'onboarding.welcomeFeaturePrivacy',
    },
    {
      icon: Sparkles,
      titleKey: 'onboarding.welcomeFeatureInsights',
    },
    {
      icon: Cpu,
      titleKey: 'onboarding.welcomeFeatureOffline',
    },
  ];

  useEffect(() => {
    if (!updatesSupported) setCheckUpdates(false);
  }, [updatesSupported]);

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
      title={t('onboarding.welcomeTitle')}
      description={t('onboarding.welcomeDescription')}
      step={1}
      hideProgress={true}
    >
      <div className="flex flex-col items-center space-y-6">
        {/* Divider */}
        <div className="w-16 h-px bg-af-hover" />

        {/* Features Card */}
        <div className="w-full max-w-md bg-af-panel rounded-lg border border-af-border shadow-sm p-6 space-y-4">
          {features.map((feature, index) => {
            const Icon = feature.icon;
            return (
              <div key={index} className="flex items-start gap-3">
                <div className="flex-shrink-0 mt-0.5">
                  <div className="w-5 h-5 rounded-full bg-af-panel-2 flex items-center justify-center">
                    <Icon className="w-3 h-3 text-af-text-2" />
                  </div>
                </div>
                <p className="text-sm text-af-text-2 leading-relaxed">{t(feature.titleKey)}</p>
              </div>
            );
          })}
        </div>

        {updatesSupported && <div className="w-full max-w-md rounded-lg border border-af-border bg-af-panel p-5 shadow-sm">
          <div className="mb-4 flex items-start gap-3">
            <div className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full bg-af-panel-2">
              <RefreshCw className="h-3.5 w-3.5 text-af-text-2" />
            </div>
            <div>
              <h2 className="text-sm font-medium text-af-text">{t('onboarding.updatesTitle')}</h2>
              <p className="mt-1 text-xs leading-relaxed text-af-text-3">
                {t('onboarding.updatesDescription')}
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
                  ? 'border-af-border-strong bg-af-elevated text-white'
                  : 'border-af-border text-af-text-2 hover:border-af-border-strong'
              }`}
            >
              {t('onboarding.updatesYes')}
            </button>
            <button
              type="button"
              onClick={() => setCheckUpdates(false)}
              aria-pressed={checkUpdates === false}
              className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                checkUpdates === false
                  ? 'border-af-border-strong bg-af-elevated text-white'
                  : 'border-af-border text-af-text-2 hover:border-af-border-strong'
              }`}
            >
              {t('onboarding.updatesNo')}
            </button>
          </div>
        </div>}

        {/* CTA Section */}
        <div className="w-full max-w-xs space-y-3">
          {checkUpdates !== null && (
            <Button
              onClick={() => void continueOnboarding()}
              disabled={saving}
              className="w-full h-11 bg-af-elevated hover:bg-af-elevated text-white"
            >
              {saving ? t('common.saving') : t('onboarding.welcomeGetStarted')}
            </Button>
          )}
          <p className="text-xs text-center text-af-text-3">{t('onboarding.welcomeTimeEstimate')}</p>
        </div>
      </div>
    </OnboardingContainer>
  );
}
