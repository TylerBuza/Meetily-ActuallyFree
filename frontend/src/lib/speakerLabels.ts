/**
 * True for the collision-free "Speaker N" labels Rust generates before a
 * speaker has been identified. Extracted from SpeakerRenameDialog so the
 * export pipeline can use the identical rule.
 */
export function isGeneratedSpeakerLabel(value: string | null | undefined): boolean {
  return !!value && /^speaker \d+$/i.test(value.trim());
}

const NON_LINKABLE_LABELS = new Set(['you', 'guest']);

/**
 * True only for a speaker label that names a real, identified person —
 * i.e. not an unresolved "Speaker N" label and not the local-user/guest
 * placeholders. Used to decide which speakers get wikilinked and which
 * appear in export frontmatter as attendees.
 */
export function isLinkableSpeakerName(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  if (NON_LINKABLE_LABELS.has(trimmed.toLowerCase())) return false;
  return !isGeneratedSpeakerLabel(trimmed);
}
