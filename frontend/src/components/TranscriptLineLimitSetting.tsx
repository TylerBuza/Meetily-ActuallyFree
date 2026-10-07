'use client';
import { useEffect, useState } from 'react';
import { Switch } from '@/components/ui/switch';
import { useTranscriptLineLimit, validLineMinutes } from '@/lib/transcript-line-limit';
export function TranscriptLineLimitSetting() {
  const [limit, save] = useTranscriptLineLimit();
  const [draft, setDraft] = useState('1');
  const [error, setError] = useState('');
  useEffect(() => setDraft(String(limit.minutes)), [limit.minutes]);
  const update = (enabled: boolean, minutes: number) => {
    try { save({ enabled, minutes }); setError(''); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  };
  return <section className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
    <div className="flex items-start justify-between gap-4">
      <div><h3 className="text-sm font-semibold text-af-text">Limit continuous transcript line duration</h3>
        <p className="mt-1 text-[13px] text-af-text-3">Start a new line during continuous speech. Applies to live and saved transcripts. Disabled means unlimited.</p></div>
      <Switch aria-label="Limit continuous transcript line duration" checked={limit.enabled} onCheckedChange={enabled => update(enabled, limit.minutes)} />
    </div>
    {limit.enabled && <label className="mt-3 flex items-center gap-3 text-sm text-af-text-2">Maximum minutes per line
      <input aria-label="Maximum minutes per transcript line" type="number" min="1" step="1" value={draft} onChange={event => setDraft(event.target.value)}
        onBlur={() => { const minutes = Number(draft); if (!validLineMinutes(minutes)) { setError('Enter a whole number of minutes, at least 1.'); return; } update(true, minutes); }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }} className="w-20 rounded border border-af-border bg-af-panel px-2 py-1" />
    </label>}
    {error && <p role="alert" className="mt-2 text-xs text-af-danger">{error}</p>}
  </section>;
}
