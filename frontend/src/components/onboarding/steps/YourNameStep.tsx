'use client';

import { useEffect, useState } from 'react';
import { useOnboarding } from '@/contexts/OnboardingContext';
import { OnboardingContainer } from '../OnboardingContainer';
import { User } from 'lucide-react';

/**
 * Capture the user's display name once. Live + post-call transcripts label
 * the local mic as "You" and the UI shows e.g. "Tyler (You)".
 */
export function YourNameStep() {
  const { goNext, goPrevious } = useOnboarding();
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
      title="What should we call you?"
      description="Your name labels your voice in transcripts as “You”. You can change this later in Settings."
      step={4}
      totalSteps={5}
      showNavigation
      onPrevious={goPrevious}
      onNext={saveAndNext}
      canGoNext
      canGoPrevious
    >
      <div className="mx-auto max-w-md space-y-4">
        <div className="flex items-center gap-3 rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-blue-500/15 text-blue-400">
            <User size={20} />
          </div>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveAndNext();
            }}
            placeholder="Your name"
            className="af-bare flex-1 border-0 bg-transparent text-base text-[var(--af-text)] placeholder:text-[var(--af-text-3)] focus:outline-none"
            autoFocus
          />
        </div>
        <p className="text-center text-xs text-[var(--af-text-3)]">
          Example: lines you speak show as <strong className="text-blue-400">{name.trim() || 'You'} (You)</strong>
        </p>
        <button
          type="button"
          onClick={saveAndNext}
          className="mt-6 h-11 w-full rounded-xl bg-[var(--af-accent)] text-sm font-semibold text-white shadow-sm transition hover:brightness-110 active:scale-[0.99]"
        >
          Continue
        </button>
      </div>
    </OnboardingContainer>
  );
}

export default YourNameStep;
