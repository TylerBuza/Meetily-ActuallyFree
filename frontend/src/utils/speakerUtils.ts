/**
 * Speaker Recognition & Color Utilities
 * 
 * Shared across live recording, transcript views, speaker management sidebar,
 * and meeting details.
 */

import { colorForName, type GroupColor } from '@/lib/group-colors';

// Speaker colors come from the theme's group palette (--af-c-*), which each
// theme tunes for its own background. The class strings stay literal so
// Tailwind can see them.
export const speakerDotPalette = [
  'bg-[var(--af-c-violet)]',
  'bg-[var(--af-c-green)]',
  'bg-[var(--af-c-amber)]',
  'bg-[var(--af-c-pink)]',
  'bg-[var(--af-c-teal)]',
  'bg-[var(--af-c-sky)]',
  'bg-[var(--af-c-red)]',
  'bg-[var(--af-c-orange)]',
];

export const speakerTextPalette = [
  'text-[var(--af-c-violet)]',
  'text-[var(--af-c-green)]',
  'text-[var(--af-c-amber)]',
  'text-[var(--af-c-pink)]',
  'text-[var(--af-c-teal)]',
  'text-[var(--af-c-sky)]',
  'text-[var(--af-c-red)]',
  'text-[var(--af-c-orange)]',
];

export const speakerBgLightPalette = [
  'bg-[color-mix(in_srgb,var(--af-c-violet)_12%,transparent)] border-[color-mix(in_srgb,var(--af-c-violet)_28%,transparent)] text-[var(--af-c-violet)]',
  'bg-[color-mix(in_srgb,var(--af-c-green)_12%,transparent)] border-[color-mix(in_srgb,var(--af-c-green)_28%,transparent)] text-[var(--af-c-green)]',
  'bg-[color-mix(in_srgb,var(--af-c-amber)_12%,transparent)] border-[color-mix(in_srgb,var(--af-c-amber)_28%,transparent)] text-[var(--af-c-amber)]',
  'bg-[color-mix(in_srgb,var(--af-c-pink)_12%,transparent)] border-[color-mix(in_srgb,var(--af-c-pink)_28%,transparent)] text-[var(--af-c-pink)]',
  'bg-[color-mix(in_srgb,var(--af-c-teal)_12%,transparent)] border-[color-mix(in_srgb,var(--af-c-teal)_28%,transparent)] text-[var(--af-c-teal)]',
  'bg-[color-mix(in_srgb,var(--af-c-sky)_12%,transparent)] border-[color-mix(in_srgb,var(--af-c-sky)_28%,transparent)] text-[var(--af-c-sky)]',
  'bg-[color-mix(in_srgb,var(--af-c-red)_12%,transparent)] border-[color-mix(in_srgb,var(--af-c-red)_28%,transparent)] text-[var(--af-c-red)]',
  'bg-[color-mix(in_srgb,var(--af-c-orange)_12%,transparent)] border-[color-mix(in_srgb,var(--af-c-orange)_28%,transparent)] text-[var(--af-c-orange)]',
];

// Literal classes per palette colour, so Tailwind generates each one.
const DOT_CLASS: Record<Exclude<GroupColor, 'slate'>, string> = {
  blue: 'bg-[var(--af-c-blue)]',
  sky: 'bg-[var(--af-c-sky)]',
  teal: 'bg-[var(--af-c-teal)]',
  green: 'bg-[var(--af-c-green)]',
  amber: 'bg-[var(--af-c-amber)]',
  orange: 'bg-[var(--af-c-orange)]',
  red: 'bg-[var(--af-c-red)]',
  pink: 'bg-[var(--af-c-pink)]',
  violet: 'bg-[var(--af-c-violet)]',
};

const TEXT_CLASS: Record<Exclude<GroupColor, 'slate'>, string> = {
  blue: 'text-[var(--af-c-blue)]',
  sky: 'text-[var(--af-c-sky)]',
  teal: 'text-[var(--af-c-teal)]',
  green: 'text-[var(--af-c-green)]',
  amber: 'text-[var(--af-c-amber)]',
  orange: 'text-[var(--af-c-orange)]',
  red: 'text-[var(--af-c-red)]',
  pink: 'text-[var(--af-c-pink)]',
  violet: 'text-[var(--af-c-violet)]',
};

/** A voice not identified yet: "Speaker 2", "Guest". */
export function isUnnamedSpeaker(speaker?: string | null): boolean {
  const label = (speaker ?? '').trim();
  return !label || /^speaker(\s+\d+)?$/i.test(label) || /^guest\b/i.test(label);
}

/**
 * A named person is drawn in their avatar's colour, so they look the same in
 * the transcript, on the meeting header and on their contact page.
 */
function namedSpeakerColor(speaker: string): Exclude<GroupColor, 'slate'> | null {
  if (isUserSpeaker(speaker) || isUnnamedSpeaker(speaker)) return null;
  return colorForName(speaker) as Exclude<GroupColor, 'slate'>;
}

/**
 * The speaker's colour as a CSS value, for tints (e.g. a transcript bubble).
 * Same rules as speakerDot: you are the accent, named people their avatar
 * colour, unnamed voices the meeting's colour slots.
 */
export function speakerColorValue(speaker?: string | null, colorIndex?: number): string {
  if (!speaker) return 'var(--af-text-4)';
  if (isUserSpeaker(speaker)) return 'var(--af-accent)';
  const named = namedSpeakerColor(speaker);
  if (named) return `var(--af-c-${named})`;
  if (colorIndex !== undefined) return SLOT_COLOR_VALUES[colorIndex % SLOT_COLOR_VALUES.length];
  const slot = /^guest\b/i.test(speaker) ? 0 : speakerPaletteIndex(speaker);
  return SLOT_COLOR_VALUES[slot % SLOT_COLOR_VALUES.length];
}

const SLOT_COLOR_VALUES = [
  'var(--af-c-violet)',
  'var(--af-c-green)',
  'var(--af-c-amber)',
  'var(--af-c-pink)',
  'var(--af-c-teal)',
  'var(--af-c-sky)',
  'var(--af-c-red)',
  'var(--af-c-orange)',
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

function getShuffledPaletteOrder(seedString: string): number[] {
  let hash = 0;
  for (let i = 0; i < seedString.length; i++) {
    hash = (hash * 31 + seedString.charCodeAt(i)) >>> 0;
  }
  const order = [0, 1, 2, 3, 4, 5, 6, 7];
  let state = hash || 1337;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/** Assign one palette slot per meeting speaker in first-spoken order.
 * Shuffles the palette so colors are random across meetings, but guarantees
 * no two speakers in the same meeting get the same color until all 8 palette colors are used. */
export function speakerColorIndexMap(labels: Iterable<string>, seed?: string): Map<string, number> {
  const labelList = Array.from(labels).map((l) => l.trim()).filter((l) => !isUserSpeaker(l) && Boolean(l));
  const paletteOrder = seed ? getShuffledPaletteOrder(seed) : [0, 1, 2, 3, 4, 5, 6, 7];

  const indices = new Map<string, number>();
  for (const label of labelList) {
    const key = speakerKey(label);
    if (!indices.has(key)) {
      const slotIndex = indices.size % paletteOrder.length;
      indices.set(key, paletteOrder[slotIndex]);
    }
  }
  return indices;
}

/** Dot colour on the timeline rail — same mapping as the text colour. */
export function speakerDot(speaker?: string | null, colorIndex?: number): string {
  if (!speaker) return 'bg-af-text-4';
  if (isUserSpeaker(speaker)) return 'bg-af-accent';
  const named = namedSpeakerColor(speaker);
  if (named) return DOT_CLASS[named];
  if (colorIndex !== undefined) return speakerDotPalette[colorIndex % speakerDotPalette.length];
  if (/^guest\b/i.test(speaker)) return speakerDotPalette[0];
  return speakerDotPalette[speakerPaletteIndex(speaker)];
}

/** Stable colour per speaker label so each speaker reads consistently. */
export function speakerColor(speaker?: string | null, colorIndex?: number): string {
  if (!speaker) return 'text-af-text-3';
  if (isUserSpeaker(speaker)) return 'text-af-accent';
  const named = namedSpeakerColor(speaker);
  if (named) return TEXT_CLASS[named];
  if (colorIndex !== undefined) return speakerTextPalette[colorIndex % speakerTextPalette.length];
  if (/^guest\b/i.test(speaker)) return speakerTextPalette[0];
  return speakerTextPalette[speakerPaletteIndex(speaker)];
}

/** Chip / badge styling per speaker */
export function speakerBadgeClass(speaker?: string | null): string {
  if (!speaker) return 'bg-af-panel-2 border-af-border text-af-text-2';
  if (isUserSpeaker(speaker)) return 'bg-af-accent/10 border-af-accent/25 text-af-accent';
  if (/^guest\b/i.test(speaker)) return speakerBgLightPalette[0];
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
