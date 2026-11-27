'use client';

import { useEffect, useState } from 'react';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { OnboardingContainer } from '../OnboardingContainer';
import { User } from 'lucide-react';
import { useI18n } from '@/i18n';

/**
 * Capture the user's display name once. Live + post-call transcripts label
 * the local mic as "You" and the UI shows e.g. "Tyler (You)".
 */
export function YourNameStep() {
  const { goNext, goPrevious } = useOnboarding();
  const { t } = useI18n();
  const [name, setName] = useState('');

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setName(localStorage.getItem('meetily_user_name')?.trim() || '');
    }
  }, []);

  const saveAndNext = () => {
    const trimmed = name.trim();
    if (typeof window !== 'undefined') {
      if (trimmed) localStorage.setItem('meetily_user_name', trimmed);
      else localStorage.removeItem('meetily_user_name');
    }
    goNext();
  };

  return (
    <OnboardingContainer
      title={t('onboarding.yourNameTitle')}
      description={t('onboarding.yourNameDescription')}
      step={4}
      totalSteps={5}
      showNavigation
      onPrevious={goPrevious}
      onNext={saveAndNext}
      canGoNext
      canGoPrevious
    >
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full bg-af-accent/15 text-af-accent">
            <User size={20} />
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveAndNext();
            }}
            placeholder={t('onboarding.yourNamePlaceholder')}
            className="h-12 min-w-0 flex-1 rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] px-4 text-base text-[var(--af-text)] placeholder:text-[var(--af-text-3)] focus:border-af-accent/40 focus:outline-none focus:ring-2 focus:ring-af-accent/50"
            autoFocus
          />
        </div>
        <p className="text-center text-xs text-[var(--af-text-3)]">
          {t('onboarding.yourNameExamplePrefix')}{' '}
          <strong className="text-af-accent">
            {name.trim() || t('onboarding.yourNameFallback')}
            {t('onboarding.yourNameSuffix')}
          </strong>
        </p>
        <button
          type="button"
          onClick={saveAndNext}
          className="mt-6 h-11 w-full rounded-xl bg-[var(--af-accent)] text-sm font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.99]"
        >
          {t('onboarding.continue')}
        </button>
      </div>
    </OnboardingContainer>
  );
}

export default YourNameStep;
