import React, { useState, useEffect } from 'react';
import { AlertTriangle, Globe, Info, Languages } from 'lucide-react';
import Analytics from '@/lib/analytics';
import { toast } from 'sonner';
import { useConfig } from '@/contexts/ConfigContext';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n, type MessageKey } from '@/i18n';

export interface Language {
  code: string;
  /** English name kept for analytics payloads; `labelKey` is the display name. */
  name: string;
  labelKey: MessageKey;
}

// ISO 639-1 language codes supported by Whisper
const LANGUAGES: Language[] = [
  { code: 'auto', name: 'Auto Detect (Original Language)', labelKey: 'models.languages.auto' },
  { code: 'auto-translate', name: 'Auto Detect (Translate to English)', labelKey: 'models.languages.autoTranslate' },
  { code: 'en', name: 'English', labelKey: 'models.languages.en' },
  { code: 'zh', name: 'Chinese', labelKey: 'models.languages.zh' },
  { code: 'de', name: 'German', labelKey: 'models.languages.de' },
  { code: 'es', name: 'Spanish', labelKey: 'models.languages.es' },
  { code: 'ru', name: 'Russian', labelKey: 'models.languages.ru' },
  { code: 'ko', name: 'Korean', labelKey: 'models.languages.ko' },
  { code: 'fr', name: 'French', labelKey: 'models.languages.fr' },
  { code: 'ja', name: 'Japanese', labelKey: 'models.languages.ja' },
  { code: 'pt', name: 'Portuguese', labelKey: 'models.languages.pt' },
  { code: 'tr', name: 'Turkish', labelKey: 'models.languages.tr' },
  { code: 'pl', name: 'Polish', labelKey: 'models.languages.pl' },
  { code: 'ca', name: 'Catalan', labelKey: 'models.languages.ca' },
  { code: 'nl', name: 'Dutch', labelKey: 'models.languages.nl' },
  { code: 'ar', name: 'Arabic', labelKey: 'models.languages.ar' },
  { code: 'sv', name: 'Swedish', labelKey: 'models.languages.sv' },
  { code: 'it', name: 'Italian', labelKey: 'models.languages.it' },
  { code: 'id', name: 'Indonesian', labelKey: 'models.languages.id' },
  { code: 'hi', name: 'Hindi', labelKey: 'models.languages.hi' },
  { code: 'fi', name: 'Finnish', labelKey: 'models.languages.fi' },
  { code: 'vi', name: 'Vietnamese', labelKey: 'models.languages.vi' },
  { code: 'he', name: 'Hebrew', labelKey: 'models.languages.he' },
  { code: 'uk', name: 'Ukrainian', labelKey: 'models.languages.uk' },
  { code: 'el', name: 'Greek', labelKey: 'models.languages.el' },
  { code: 'ms', name: 'Malay', labelKey: 'models.languages.ms' },
  { code: 'cs', name: 'Czech', labelKey: 'models.languages.cs' },
  { code: 'ro', name: 'Romanian', labelKey: 'models.languages.ro' },
  { code: 'da', name: 'Danish', labelKey: 'models.languages.da' },
  { code: 'hu', name: 'Hungarian', labelKey: 'models.languages.hu' },
  { code: 'ta', name: 'Tamil', labelKey: 'models.languages.ta' },
  { code: 'no', name: 'Norwegian', labelKey: 'models.languages.no' },
  { code: 'th', name: 'Thai', labelKey: 'models.languages.th' },
  { code: 'ur', name: 'Urdu', labelKey: 'models.languages.ur' },
  { code: 'hr', name: 'Croatian', labelKey: 'models.languages.hr' },
  { code: 'bg', name: 'Bulgarian', labelKey: 'models.languages.bg' },
  { code: 'lt', name: 'Lithuanian', labelKey: 'models.languages.lt' },
  { code: 'la', name: 'Latin', labelKey: 'models.languages.la' },
  { code: 'mi', name: 'Maori', labelKey: 'models.languages.mi' },
  { code: 'ml', name: 'Malayalam', labelKey: 'models.languages.ml' },
  { code: 'cy', name: 'Welsh', labelKey: 'models.languages.cy' },
  { code: 'sk', name: 'Slovak', labelKey: 'models.languages.sk' },
  { code: 'te', name: 'Telugu', labelKey: 'models.languages.te' },
  { code: 'fa', name: 'Persian', labelKey: 'models.languages.fa' },
  { code: 'lv', name: 'Latvian', labelKey: 'models.languages.lv' },
  { code: 'bn', name: 'Bengali', labelKey: 'models.languages.bn' },
  { code: 'sr', name: 'Serbian', labelKey: 'models.languages.sr' },
  { code: 'az', name: 'Azerbaijani', labelKey: 'models.languages.az' },
  { code: 'sl', name: 'Slovenian', labelKey: 'models.languages.sl' },
  { code: 'kn', name: 'Kannada', labelKey: 'models.languages.kn' },
  { code: 'et', name: 'Estonian', labelKey: 'models.languages.et' },
  { code: 'mk', name: 'Macedonian', labelKey: 'models.languages.mk' },
  { code: 'br', name: 'Breton', labelKey: 'models.languages.br' },
  { code: 'eu', name: 'Basque', labelKey: 'models.languages.eu' },
  { code: 'is', name: 'Icelandic', labelKey: 'models.languages.is' },
  { code: 'hy', name: 'Armenian', labelKey: 'models.languages.hy' },
  { code: 'ne', name: 'Nepali', labelKey: 'models.languages.ne' },
  { code: 'mn', name: 'Mongolian', labelKey: 'models.languages.mn' },
  { code: 'bs', name: 'Bosnian', labelKey: 'models.languages.bs' },
  { code: 'kk', name: 'Kazakh', labelKey: 'models.languages.kk' },
  { code: 'sq', name: 'Albanian', labelKey: 'models.languages.sq' },
  { code: 'sw', name: 'Swahili', labelKey: 'models.languages.sw' },
  { code: 'gl', name: 'Galician', labelKey: 'models.languages.gl' },
  { code: 'mr', name: 'Marathi', labelKey: 'models.languages.mr' },
  { code: 'pa', name: 'Punjabi', labelKey: 'models.languages.pa' },
  { code: 'si', name: 'Sinhala', labelKey: 'models.languages.si' },
  { code: 'km', name: 'Khmer', labelKey: 'models.languages.km' },
  { code: 'sn', name: 'Shona', labelKey: 'models.languages.sn' },
  { code: 'yo', name: 'Yoruba', labelKey: 'models.languages.yo' },
  { code: 'so', name: 'Somali', labelKey: 'models.languages.so' },
  { code: 'af', name: 'Afrikaans', labelKey: 'models.languages.af' },
  { code: 'oc', name: 'Occitan', labelKey: 'models.languages.oc' },
  { code: 'ka', name: 'Georgian', labelKey: 'models.languages.ka' },
  { code: 'be', name: 'Belarusian', labelKey: 'models.languages.be' },
  { code: 'tg', name: 'Tajik', labelKey: 'models.languages.tg' },
  { code: 'sd', name: 'Sindhi', labelKey: 'models.languages.sd' },
  { code: 'gu', name: 'Gujarati', labelKey: 'models.languages.gu' },
  { code: 'am', name: 'Amharic', labelKey: 'models.languages.am' },
  { code: 'yi', name: 'Yiddish', labelKey: 'models.languages.yi' },
  { code: 'lo', name: 'Lao', labelKey: 'models.languages.lo' },
  { code: 'uz', name: 'Uzbek', labelKey: 'models.languages.uz' },
  { code: 'fo', name: 'Faroese', labelKey: 'models.languages.fo' },
  { code: 'ht', name: 'Haitian Creole', labelKey: 'models.languages.ht' },
  { code: 'ps', name: 'Pashto', labelKey: 'models.languages.ps' },
  { code: 'tk', name: 'Turkmen', labelKey: 'models.languages.tk' },
  { code: 'nn', name: 'Norwegian Nynorsk', labelKey: 'models.languages.nn' },
  { code: 'mt', name: 'Maltese', labelKey: 'models.languages.mt' },
  { code: 'sa', name: 'Sanskrit', labelKey: 'models.languages.sa' },
  { code: 'lb', name: 'Luxembourgish', labelKey: 'models.languages.lb' },
  { code: 'my', name: 'Myanmar', labelKey: 'models.languages.my' },
  { code: 'bo', name: 'Tibetan', labelKey: 'models.languages.bo' },
  { code: 'tl', name: 'Tagalog', labelKey: 'models.languages.tl' },
  { code: 'mg', name: 'Malagasy', labelKey: 'models.languages.mg' },
  { code: 'as', name: 'Assamese', labelKey: 'models.languages.as' },
  { code: 'tt', name: 'Tatar', labelKey: 'models.languages.tt' },
  { code: 'haw', name: 'Hawaiian', labelKey: 'models.languages.haw' },
  { code: 'ln', name: 'Lingala', labelKey: 'models.languages.ln' },
  { code: 'ha', name: 'Hausa', labelKey: 'models.languages.ha' },
  { code: 'ba', name: 'Bashkir', labelKey: 'models.languages.ba' },
  { code: 'jw', name: 'Javanese', labelKey: 'models.languages.jw' },
  { code: 'su', name: 'Sundanese', labelKey: 'models.languages.su' },
];

import type { TranscriptModelProps } from './TranscriptSettings';

interface LanguageSelectionProps {
  selectedLanguage: string;
  onLanguageChange: (language: string) => void;
  disabled?: boolean;
  provider?: TranscriptModelProps['provider'];
}

export function LanguageSelection({
  selectedLanguage,
  onLanguageChange,
  disabled = false,
  provider = 'localWhisper'
}: LanguageSelectionProps) {
  const { t } = useI18n();
  const [saving, setSaving] = useState(false);
  const { setSelectedLanguage } = useConfig();

  // Parakeet only supports auto-detection (doesn't support manual language selection)
  const isParakeet = provider === 'parakeet';
  const availableLanguages = isParakeet
    ? LANGUAGES.filter(lang => lang.code === 'auto' || lang.code === 'auto-translate')
    : LANGUAGES;

  const handleLanguageChange = async (languageCode: string) => {
    setSaving(true);
    try {
      // Save language preference to localStorage and sync to backend
      setSelectedLanguage(languageCode);
      onLanguageChange(languageCode);
      console.log('Language preference saved:', languageCode);

      // Track language selection analytics
      const selectedLang = LANGUAGES.find(lang => lang.code === languageCode);
      await Analytics.track('language_selected', {
        language_code: languageCode,
        language_name: selectedLang?.name || 'Unknown',
        is_auto_detect: (languageCode === 'auto').toString(),
        is_auto_translate: (languageCode === 'auto-translate').toString()
      });

      // Show success toast
      const languageName = selectedLang ? t(selectedLang.labelKey) : languageCode;
      toast.success(t('models.languagePreferenceSaved'), {
        description: t('models.languageSetTo', { language: languageName })
      });
    } catch (error) {
      console.error('Failed to save language preference:', error);
      toast.error(t('models.failedToSaveLanguagePreference'), {
        description: error instanceof Error ? error.message : String(error)
      });
    } finally {
      setSaving(false);
    }
  };

  // Find the selected language name for display
  const selectedLanguageEntry = LANGUAGES.find(
    lang => lang.code === selectedLanguage
  );
  const selectedLanguageLabel = selectedLanguageEntry
    ? t(selectedLanguageEntry.labelKey)
    : t('models.languages.auto');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-af-text-2" />
          <h4 className="text-sm font-medium text-af-text">{t('models.transcriptionLanguageTitle')}</h4>
        </div>
      </div>

      <div className="space-y-2">
        <Select value={selectedLanguage} onValueChange={handleLanguageChange} disabled={disabled || saving}>
          <SelectTrigger aria-label={t('models.transcriptionLanguageAria')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {availableLanguages.map((language) => (
              <SelectItem key={language.code} value={language.code}>
                {t(language.labelKey)}
                {language.code !== 'auto' && language.code !== 'auto-translate' && (
                  <span className="ml-1.5 text-af-text-4">{language.code}</span>
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Parakeet language limitation warning */}
        {isParakeet && (
          <div className="flex gap-2.5 rounded-lg border border-af-border bg-af-panel-2 px-3 py-2.5 text-xs text-af-text-2">
            <Info className="mt-px h-4 w-4 shrink-0 text-af-text-3" />
            <div>
              <p className="font-medium text-af-text">{t('models.parakeetDetectsLanguage')}</p>
              <p className="mt-0.5">{t('models.parakeetLanguageOnlyAuto')}</p>
            </div>
          </div>
        )}

        {/* Info text */}
        <div className="text-xs space-y-2 pt-2">
          <p className="text-af-text-2">
            <strong>{t('models.currentLabel')}</strong> {selectedLanguageLabel}
          </p>
          {selectedLanguage === 'auto' && (
            <div className="flex gap-2.5 rounded-lg border border-af-warning/35 bg-af-warning/10 px-3 py-2.5 text-af-text-2">
              <AlertTriangle className="mt-px h-4 w-4 shrink-0 text-af-warning" />
              <div>
                <p className="font-medium text-af-text">{t('models.autoDetectWarningTitle')}</p>
                <p className="mt-0.5">{t('models.autoDetectWarningDesc')}</p>
              </div>
            </div>
          )}
          {selectedLanguage === 'auto-translate' && (
            <div className="flex gap-2.5 rounded-lg border border-af-accent/35 bg-af-accent/10 px-3 py-2.5 text-af-text-2">
              <Languages className="mt-px h-4 w-4 shrink-0 text-af-accent" />
              <div>
                <p className="font-medium text-af-text">{t('models.translatedToEnglishTitle')}</p>
                <p className="mt-0.5">{t('models.translatedToEnglishDesc')}</p>
              </div>
            </div>
          )}
          {selectedLanguage !== 'auto' && selectedLanguage !== 'auto-translate' && (
            <p className="text-af-text-2">
              {t('models.transcriptionOptimizedFor', { language: selectedLanguageLabel })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
