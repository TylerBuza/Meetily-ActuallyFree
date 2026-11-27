'use client'

/**
 * Interface-language picker (Settings → General).
 *
 * This is the interface language only. The transcription language and the
 * summary output language remain separate settings in their own sections.
 */
import { Check, Languages } from 'lucide-react'
import { LOCALES, useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

export function UiLanguagePicker() {
  const { locale, setLocale, t } = useI18n()

  return (
    <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
      <div className="flex items-start gap-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-af-accent/[0.12] text-af-accent">
          <Languages className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-[15px] font-semibold text-af-text">{t('settings.uiLanguageTitle')}</h3>
          <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">{t('settings.uiLanguageDescription')}</p>
          <div
            role="radiogroup"
            aria-label={t('settings.uiLanguageTitle')}
            className="mt-3 flex flex-wrap gap-2"
          >
            {LOCALES.map((entry) => {
              const selected = entry.id === locale
              return (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => setLocale(entry.id)}
                  className={cn(
                    'inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-[13px] font-medium transition-colors',
                    selected
                      ? 'border-af-accent/60 bg-af-accent/[0.12] text-af-text'
                      : 'border-af-border text-af-text-2 hover:border-af-border-strong hover:text-af-text',
                  )}
                >
                  <span>{entry.nativeLabel}</span>
                  {selected && <Check className="h-3.5 w-3.5 text-af-accent" />}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-af-text-4">{t('settings.uiLanguageApplied')}</p>
        </div>
      </div>
    </div>
  )
}
