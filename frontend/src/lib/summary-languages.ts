import type { MessageKey } from '@/i18n'

export interface LanguageOption {
  code: string;
  /** English name, kept for logs and as the source text for translations. */
  label: string;
  /** Interface-catalogue key for the name shown in the pickers. */
  labelKey: MessageKey;
}

/**
 * Language options offered in the summary language pickers.
 * Codes must stay in sync with `language_name_from_code` in
 * `frontend/src-tauri/src/summary/processor.rs`.
 */
export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { code: 'en', label: 'English', labelKey: 'models.languages.en' },
  { code: 'zh', label: 'Chinese', labelKey: 'models.languages.zh' },
  { code: 'zh-tw', label: 'Traditional Chinese', labelKey: 'models.languages.zhTw' },
  { code: 'de', label: 'German', labelKey: 'models.languages.de' },
  { code: 'es', label: 'Spanish', labelKey: 'models.languages.es' },
  { code: 'ru', label: 'Russian', labelKey: 'models.languages.ru' },
  { code: 'ko', label: 'Korean', labelKey: 'models.languages.ko' },
  { code: 'fr', label: 'French', labelKey: 'models.languages.fr' },
  { code: 'ja', label: 'Japanese', labelKey: 'models.languages.ja' },
  { code: 'pt', label: 'Portuguese', labelKey: 'models.languages.pt' },
  { code: 'it', label: 'Italian', labelKey: 'models.languages.it' },
  { code: 'nl', label: 'Dutch', labelKey: 'models.languages.nl' },
  { code: 'pl', label: 'Polish', labelKey: 'models.languages.pl' },
  { code: 'ar', label: 'Arabic', labelKey: 'models.languages.ar' },
  { code: 'hi', label: 'Hindi', labelKey: 'models.languages.hi' },
  { code: 'ta', label: 'Tamil', labelKey: 'models.languages.ta' },
  { code: 'tr', label: 'Turkish', labelKey: 'models.languages.tr' },
  { code: 'vi', label: 'Vietnamese', labelKey: 'models.languages.vi' },
  { code: 'th', label: 'Thai', labelKey: 'models.languages.th' },
  { code: 'id', label: 'Indonesian', labelKey: 'models.languages.id' },
  { code: 'sv', label: 'Swedish', labelKey: 'models.languages.sv' },
  { code: 'cs', label: 'Czech', labelKey: 'models.languages.cs' },
  { code: 'da', label: 'Danish', labelKey: 'models.languages.da' },
  { code: 'fi', label: 'Finnish', labelKey: 'models.languages.fi' },
  { code: 'el', label: 'Greek', labelKey: 'models.languages.el' },
  { code: 'he', label: 'Hebrew', labelKey: 'models.languages.he' },
  { code: 'hu', label: 'Hungarian', labelKey: 'models.languages.hu' },
  { code: 'no', label: 'Norwegian', labelKey: 'models.languages.no' },
  { code: 'ro', label: 'Romanian', labelKey: 'models.languages.ro' },
  { code: 'uk', label: 'Ukrainian', labelKey: 'models.languages.uk' },
];

export const AUTO_VALUE = '__auto__' as const;

const SUPPORTED_CODES: ReadonlySet<string> = new Set(LANGUAGE_OPTIONS.map((o) => o.code));

/**
 * Normalises a raw locale string (from transcription or storage) into a code we
 * can translate into. Handles BCP-47 regional tags: `pt-BR` -> `pt`, `en_GB` -> `en`.
 * Returns null for unsupported languages so callers can fall back to English
 * rather than sending a code Rust will silently drop.
 */
export function normaliseLanguageCode(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase().replace(/_/g, '-');
  if (SUPPORTED_CODES.has(lower)) return lower;
  const base = lower.split('-')[0];
  if (SUPPORTED_CODES.has(base)) return base;
  return null;
}

export function labelForCode(code: string): string {
  return LANGUAGE_OPTIONS.find((l) => l.code === code)?.label ?? code;
}

/** Catalogue key for the picker label; falls back to the English label. */
export function labelKeyForCode(code: string): MessageKey | null {
  return LANGUAGE_OPTIONS.find((l) => l.code === code)?.labelKey ?? null;
}
