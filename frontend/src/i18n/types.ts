/**
 * Message typing helpers.
 *
 * `en` is the source of truth: its shape defines every allowed message path.
 * Translations are typed with `Translatable<typeof en>`, which widens the
 * English literal types to `string` while keeping the exact same key shape, so
 * a missing or misspelled key in a translation fails TypeScript compilation.
 */

/** Widens a nested message tree's leaf literals to plain strings. */
export type Translatable<T> = {
  [K in keyof T]: T[K] extends string ? string : Translatable<T[K]>
}

/** Dotted paths to every message leaf, e.g. `"sidebar.newRecording"`. */
export type MessagePath<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends string
    ? `${Prefix}${K}`
    : MessagePath<T[K], `${Prefix}${K}.`>
}[keyof T & string]

/** Values substituted into `{placeholders}` in a message. */
export type TranslateValues = Record<string, string | number>

/** Flattens a nested message tree into `{ "namespace.key": "text" }`. */
export function flattenMessages(
  tree: Record<string, unknown>,
  prefix = '',
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === 'string') {
      out[path] = value
    } else if (value && typeof value === 'object') {
      flattenMessages(value as Record<string, unknown>, path, out)
    }
  }
  return out
}
