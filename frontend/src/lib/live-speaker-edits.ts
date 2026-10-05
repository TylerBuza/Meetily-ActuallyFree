import { resolveSpeaker, replaceSpeakerComponent } from '@/utils/speakerUtils';
/** Meeting-scoped display edits. Keep native source labels intact and replay edits
 * over live history and crash recovery using sequence IDs (UI IDs change on reload).
 * Persist before changing the UI so a failed storage write cannot look successful.
 */
type Edits = { aliases: Record<string, string>; turns: Record<string, string>; forward?: Array<{ channel: string; sequence: number; name: string }> };
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

export function editedSpeaker(id: string | null, sequence: number, source?: string, channel?: string): string | undefined {
  if (!id) return source;
  const edits = read(id);
  if (Object.hasOwn(edits.turns, String(sequence))) return edits.turns[String(sequence)] || undefined;
  const correction = channel && edits.forward?.filter(edit => edit.channel === channel && sequence >= edit.sequence).sort((a,b) => b.sequence-a.sequence)[0];
  if (correction) return correction.name;
  return source ? resolveSpeaker(source, edits.aliases) : source;
}

export function persistSpeakerRename(id: string, from: string, to: string): Record<string, string> {
  const edits = read(id);
  for (const edit of edits.forward ?? []) edit.name = replaceSpeakerComponent(edit.name, from, to);
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

/** A channel correction starts at one immutable sequence, preserving earlier turns. */
export function persistForwardSpeaker(id: string, channel: string, sequence: number, name: string) {
  if (!/^Speaker \d+$/.test(channel) || !Number.isSafeInteger(sequence) || sequence < 0 || !name.trim()) throw new Error('Invalid speaker separation');
  const edits = read(id);
  // The explicit onward action replaces this boundary line's earlier per-line assignment.
  delete edits.turns[String(sequence)];
  edits.forward = [...(edits.forward ?? []).filter(edit => edit.channel !== channel || edit.sequence !== sequence), { channel, sequence, name: name.trim() }];
  localStorage.setItem(key(id), JSON.stringify(edits));
}
