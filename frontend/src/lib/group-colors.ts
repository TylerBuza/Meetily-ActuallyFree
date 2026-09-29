/**
 * The palette a user can pick group colors from. Each key maps to a CSS
 * variable (`--af-c-<key>`) that every theme tunes for its own background, so
 * a "blue" group stays legible on navy, cream, and brown alike.
 */
export const GROUP_COLORS = [
  { key: 'blue', label: 'Blue' },
  { key: 'sky', label: 'Sky' },
  { key: 'teal', label: 'Teal' },
  { key: 'green', label: 'Green' },
  { key: 'amber', label: 'Amber' },
  { key: 'orange', label: 'Orange' },
  { key: 'red', label: 'Red' },
  { key: 'pink', label: 'Pink' },
  { key: 'violet', label: 'Violet' },
  { key: 'slate', label: 'Slate' },
] as const;

export type GroupColor = (typeof GROUP_COLORS)[number]['key'];

export const DEFAULT_GROUP_COLOR: GroupColor = 'blue';

export function isGroupColor(value: unknown): value is GroupColor {
  return typeof value === 'string' && GROUP_COLORS.some((color) => color.key === value);
}

/** CSS value for a color key; unknown keys fall back to the default. */
export function groupColorVar(color?: string | null): string {
  return `var(--af-c-${isGroupColor(color) ? color : DEFAULT_GROUP_COLOR})`;
}

/** Deterministic color for things without a chosen one (avatars, new groups). */
export function colorForName(name: string): GroupColor {
  let hash = 0;
  const normalized = name.trim().toLowerCase();
  for (let i = 0; i < normalized.length; i++) {
    hash = (hash * 31 + normalized.charCodeAt(i)) >>> 0;
  }
  // Slate is kept for "no color"; skip it for generated colors.
  const palette = GROUP_COLORS.filter((color) => color.key !== 'slate');
  return palette[hash % palette.length].key;
}
