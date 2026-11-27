'use client';

import { useState } from 'react';
import { Globe, Pin } from 'lucide-react';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { LanguagePickerPopover } from '@/components/LanguagePickerPopover';
import { useRecentLanguages } from '@/hooks/useRecentLanguages';
import { labelForCode } from '@/lib/summary-languages';
import { useI18n, type MessageKey } from '@/i18n';

/** Translated language names by code; the codes themselves are never shown in Chinese. */
const LANGUAGE_LABEL_KEYS: Record<string, MessageKey> = {
  en: 'summaries.languageEn',
  zh: 'summaries.languageZh',
  'zh-tw': 'summaries.languageZhTw',
  de: 'summaries.languageDe',
  es: 'summaries.languageEs',
  ru: 'summaries.languageRu',
  ko: 'summaries.languageKo',
  fr: 'summaries.languageFr',
  ja: 'summaries.languageJa',
  pt: 'summaries.languagePt',
  it: 'summaries.languageIt',
  nl: 'summaries.languageNl',
  pl: 'summaries.languagePl',
  ar: 'summaries.languageAr',
  hi: 'summaries.languageHi',
  ta: 'summaries.languageTa',
  tr: 'summaries.languageTr',
  vi: 'summaries.languageVi',
  th: 'summaries.languageTh',
  id: 'summaries.languageId',
  sv: 'summaries.languageSv',
  cs: 'summaries.languageCs',
  da: 'summaries.languageDa',
  fi: 'summaries.languageFi',
  el: 'summaries.languageEl',
  he: 'summaries.languageHe',
  hu: 'summaries.languageHu',
  no: 'summaries.languageNo',
  ro: 'summaries.languageRo',
  uk: 'summaries.languageUk',
};

export function SummaryLanguageSettings() {
  const { t } = useI18n();
  const { recents, pinned, addRecent, removeRecent, setPinned } = useRecentLanguages();
  const [pickerOpen, setPickerOpen] = useState(false);

  const togglePin = (code: string) => {
    setPinned(pinned === code ? null : code);
  };

  /** Language codes are stored and sent to the model as-is; only the name is translated. */
  const languageLabel = (code: string) => {
    const key = LANGUAGE_LABEL_KEYS[code];
    return key ? t(key) : labelForCode(code);
  };

  return (
    <div className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5 relative">
      <div className="flex items-center gap-2 mb-2">
        <Globe size={18} className="text-af-text-3" />
        <h3 className="text-[15px] font-semibold text-af-text">{t('summaries.summaryLanguage')}</h3>
      </div>
      <p className="text-sm text-af-text-2 mb-4">
        {t('summaries.summaryLanguageDescription')}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {recents.map((code) => {
          const isPinned = pinned === code;
          return (
            <span
              key={code}
              className={`inline-flex items-center rounded-full border text-sm overflow-hidden ${
                isPinned
                  ? 'bg-af-accent/10 border-af-accent/40 text-af-accent'
                  : 'bg-af-panel-2 border-af-border text-af-text'
              }`}
            >
              <button
                type="button"
                aria-label={
                  isPinned
                    ? t('summaries.unpinAsDefault', { language: languageLabel(code) })
                    : t('summaries.pinAsDefault', { language: languageLabel(code) })
                }
                aria-pressed={isPinned}
                title={isPinned ? t('summaries.clickToUnsetDefault') : t('summaries.clickToSetDefault')}
                onClick={() => togglePin(code)}
                className={`flex items-center gap-1.5 pl-3 pr-2 py-1 hover:brightness-95 active:brightness-90 ${
                  isPinned ? 'text-af-accent' : 'text-af-text'
                }`}
              >
                <Pin
                  size={14}
                  className={isPinned ? 'text-af-accent' : 'text-af-text-4'}
                  fill={isPinned ? 'currentColor' : 'none'}
                />
                {languageLabel(code)}
              </button>
              <button
                type="button"
                aria-label={t('summaries.removeLanguage', { language: languageLabel(code) })}
                onClick={() => removeRecent(code)}
                className={`pr-2.5 pl-0.5 py-1 leading-none ${isPinned ? 'text-af-accent hover:text-af-accent' : 'text-af-text-4 hover:text-af-text-2'}`}
              >
                ×
              </button>
            </span>
          );
        })}

        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={recents.length >= 5}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-af-border-strong px-3 py-1 text-sm text-af-text-2 hover:border-af-border-strong hover:text-af-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('summaries.addLanguage')}
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto p-0 border-0 shadow-none bg-transparent">
            <LanguagePickerPopover
              mode="settings"
              value={null}
              onChange={(code) => {
                if (code) addRecent(code);
                setPickerOpen(false);
              }}
              onClose={() => setPickerOpen(false)}
            />
          </PopoverContent>
        </Popover>
      </div>

      <p className="text-xs text-af-text-4 mt-3">
        {pinned
          ? t('summaries.pinnedDefaultHint', { language: languageLabel(pinned) })
          : t('summaries.defaultLanguageHint')}
      </p>
    </div>
  );
}
