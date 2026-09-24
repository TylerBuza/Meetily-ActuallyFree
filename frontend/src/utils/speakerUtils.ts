/**
 * Speaker Recognition & Color Utilities
 * 
 * Shared across live recording, transcript views, speaker management sidebar,
 * and meeting details.
 */

export const speakerDotPalette = [
  'bg-purple-500',
  'bg-emerald-500',
  'bg-amber-500',
  'bg-pink-500',
  'bg-cyan-500',
  'bg-indigo-500',
  'bg-rose-500',
  'bg-teal-500',
];

export const speakerTextPalette = [
  'text-purple-600 dark:text-purple-400',
  'text-emerald-600 dark:text-emerald-400',
  'text-amber-600 dark:text-amber-400',
  'text-pink-600 dark:text-pink-400',
  'text-cyan-600 dark:text-cyan-400',
  'text-indigo-600 dark:text-indigo-400',
  'text-rose-600 dark:text-rose-400',
  'text-teal-600 dark:text-teal-400',
];

export const speakerBgLightPalette = [
  'bg-purple-500/10 border-purple-500/20 text-purple-600 dark:text-purple-400',
  'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400',
  'bg-amber-500/10 border-amber-500/20 text-amber-600 dark:text-amber-400',
  'bg-pink-500/10 border-pink-500/20 text-pink-600 dark:text-pink-400',
  'bg-cyan-500/10 border-cyan-500/20 text-cyan-600 dark:text-cyan-400',
  'bg-indigo-500/10 border-indigo-500/20 text-indigo-600 dark:text-indigo-400',
  'bg-rose-500/10 border-rose-500/20 text-rose-600 dark:text-rose-400',
  'bg-teal-500/10 border-teal-500/20 text-teal-600 dark:text-teal-400',
];

export function isUserSpeaker(speaker?: string | null): boolean {
  if (!speaker) return false;
  const normalized = speaker.trim();
  return /^you\b/i.test(normalized) || /\(\s*you\s*\)$/i.test(normalized);
}

export function displaySpeaker(speaker: string, userName: string): string {
  if (isUserSpeaker(speaker)) {
    return userName ? `${userName} (You)` : 'You';
  }
  return speaker;
}

/** Normalize speaker keys so "You" / "you" / empty compare cleanly. */
export function speakerKey(speaker?: string | null): string {
  if (isUserSpeaker(speaker)) return '__you__';
  return (speaker ?? '').trim().toLowerCase() || '__unknown__';
}

export function speakerPaletteIndex(speaker: string): number {
  const numberedSpeaker = speaker.trim().match(/^speaker\s+(\d+)$/i);
  if (numberedSpeaker) {
    return (Number(numberedSpeaker[1]) - 1) % speakerDotPalette.length;
  }
  let hash = 0;
  const normalized = speaker.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  return hash % speakerDotPalette.length;
}

/** Dot colour on the timeline rail — same mapping as the text colour. */
export function speakerDot(speaker?: string | null): string {
  if (!speaker) return 'bg-gray-400';
  if (isUserSpeaker(speaker)) return 'bg-blue-500';
  if (/^guest\b/i.test(speaker)) return 'bg-purple-500';
  return speakerDotPalette[speakerPaletteIndex(speaker)];
}

/** Stable colour per speaker label so each speaker reads consistently. */
export function speakerColor(speaker?: string | null): string {
  if (!speaker) return 'text-gray-500';
  if (isUserSpeaker(speaker)) return 'text-blue-500';
  if (/^guest\b/i.test(speaker)) return 'text-purple-500';
  return speakerTextPalette[speakerPaletteIndex(speaker)];
}

/** Chip / badge styling per speaker */
export function speakerBadgeClass(speaker?: string | null): string {
  if (!speaker) return 'bg-gray-100 border-gray-200 text-gray-700 dark:bg-gray-800 dark:text-gray-300';
  if (isUserSpeaker(speaker)) return 'bg-blue-500/10 border-blue-500/25 text-blue-600 dark:text-blue-400';
  if (/^guest\b/i.test(speaker)) return 'bg-purple-500/10 border-purple-500/25 text-purple-600 dark:text-purple-400';
  return speakerBgLightPalette[speakerPaletteIndex(speaker)];
}

/**
 * Resolves a raw or previously assigned speaker label through any user-defined mappings or merges.
 * Follows renames and merges until stable.
 */
export function resolveSpeaker(rawSpeaker: string, speakerMap: Record<string, string>): string {
  let current = rawSpeaker.trim();
  let depth = 0;
  const visited = new Set<string>();

  while (speakerMap[current] && speakerMap[current] !== current && depth < 20) {
    if (visited.has(current)) break; // cycle prevention
    visited.add(current);
    current = speakerMap[current].trim();
    depth++;
  }

  return current;
}
