import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { completeSummaryMarkdown } from './summary-markdown';
const EVENT = 'meetily-summary-speaker-names-changed';
export type AISpeakerNames = Readonly<Record<string, string>>;

/** Only explicit standalone name/channel pairs or owner table cells qualify.
 * Mentioning a name elsewhere never associates that person with a voice.
 */
export function parseAISpeakerNames(markdown: string): AISpeakerNames {
  const candidates = new Map<string, Map<string, string>>();
  for (const line of markdown.split(/\r?\n/)) {
    for (const cell of line.split('|')) {
      const text = cell.trim().replace(/^[-*]\s+/, '').replace(/\*\*/g, '').replace(/^(?:Owner|Assignee|Participant):\s*/i, '');
      const pair = text.match(/^([\p{L}\p{M}][\p{L}\p{M} .'’-]{0,79}?)\s*\(Speaker\s+(\d+)\)\s*[.]?$/u);
      if (!pair) continue;
      const name = pair[1].trim(); const number = Number(pair[2]);
      if (!Number.isSafeInteger(number) || number < 1 || /^(?:you|unknown|none|unidentified|speaker(?: \d+)?)$/i.test(name)) continue;
      const speaker = `Speaker ${number}`;
      const names = candidates.get(speaker) ?? new Map<string,string>();
      names.set(name.toLocaleLowerCase(), name); candidates.set(speaker, names);
    }
  }
  return Object.fromEntries([...candidates].filter(([,names]) => names.size === 1).map(([speaker,names]) => [speaker, [...names.values()][0]]));
}
export function summarySpeakerNames(summary: unknown, userEdited = false): AISpeakerNames {
  if (userEdited) return {};
  const cached = (summary as {english_cache?: {markdown?: string}} | null)?.english_cache?.markdown;
  return parseAISpeakerNames(cached || completeSummaryMarkdown(summary));
}
export function hasAISpeakerName(speaker: string, names: AISpeakerNames): boolean {
  return speaker.split(' + ').some(part => /^Speaker \d+$/.test(part) && !!names[part]);
}
/** A label only: original row speaker, source channel, text and IDs stay intact. */
export function projectAISpeakerLabel(speaker: string, names: AISpeakerNames): string {
  return speaker.split(' + ').map(part => /^Speaker \d+$/.test(part) && names[part] ? `${names[part]} (${part})` : part).join(' + ');
}
export function useSummarySpeakerNames() {
  const [enabled, setEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const load = () => {
      const request = ++generation.current;
      void invoke<boolean>('get_summary_speaker_names_enabled').then(value => {
        if (request === generation.current) { setEnabled(value === true); setReady(true); setError(''); }
      }).catch(reason => { if (request === generation.current) setError(String(reason)); });
    };
    load(); window.addEventListener(EVENT, load);
    return () => { generation.current++; window.removeEventListener(EVENT, load); };
  }, []);
  const save = async (value: boolean) => {
    setBusy(true); setError(''); generation.current++;
    try {
      await invoke('set_summary_speaker_names_enabled', {value});
      setEnabled(value); window.dispatchEvent(new Event(EVENT));
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return {enabled, ready, busy, error, save};
}
