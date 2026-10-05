import { resolveSpeaker, replaceSpeakerComponent } from '@/utils/speakerUtils';
/** Meeting-scoped display edits. Keep native source labels intact and replay edits
 * over live history and crash recovery using sequence IDs (UI IDs change on reload).
 * Persist before changing the UI so a failed storage write cannot look successful.
 */
type Edits = { aliases: Record<string, string>; turns: Record<string, string> };
const key = (id: string) => `meetily-speaker-edits:${id}`;

export function activeSpeakerMeeting(): string | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem('indexeddb_current_meeting_id');
}

function read(id: string): Edits {
  const value = localStorage.getItem(key(id));
  if (!value) return { aliases: {}, turns: {} };
  const parsed = JSON.parse(value) as Edits;
  if (!parsed.aliases || !parsed.turns) throw new Error('Invalid saved speaker edits');
  return parsed;
}

export function editedSpeaker(id: string | null, sequence: number, source?: string): string | undefined {
  if (!id) return source;
  const edits = read(id);
  if (Object.hasOwn(edits.turns, String(sequence))) return edits.turns[String(sequence)] || undefined;
  return source ? resolveSpeaker(source, edits.aliases) : source;
}

export function persistSpeakerRename(id: string, from: string, to: string): Record<string, string> {
  const edits = read(id);
  // Flatten aliases once; resolving a chain can cycle when a name is restored.
  for (const [raw, name] of Object.entries(edits.aliases)) edits.aliases[raw] = replaceSpeakerComponent(name, from, to);
  for (const [turn, name] of Object.entries(edits.turns)) edits.turns[turn] = replaceSpeakerComponent(name, from, to);
  Object.defineProperty(edits.aliases, from, { value: to, enumerable: true, writable: true, configurable: true });
  localStorage.setItem(key(id), JSON.stringify(edits));
  return edits.aliases;
}

export function persistTurnSpeaker(id: string, sequence: number, speaker: string) {
  const edits = read(id);
  edits.turns[String(sequence)] = speaker;
  localStorage.setItem(key(id), JSON.stringify(edits));
}
