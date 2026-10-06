"use client";
import { Switch } from './ui/switch';
import { useSummarySpeakerNames } from '@/lib/summary-speaker-names';
export function SummarySpeakerNamesSetting() {
  const {enabled, ready, busy, error, save} = useSummarySpeakerNames();
  return <section className="rounded-2xl border border-af-border bg-af-panel-2/40 p-5">
    <div className="flex items-start justify-between gap-4">
      <div><h3 className="text-[15px] font-semibold text-af-text">Suggest speaker names after AI summary</h3>
      <p className="mt-0.5 text-[13px] leading-relaxed text-af-text-3">Off by default. Display names explicitly linked to anonymous speakers in the AI summary, such as Tony (Speaker 7), marked AI · unsaved. These are guesses from text, not saved contacts or voice matches. Transcript speaker labels stay unchanged until you review and save a name. New summaries request supported name suggestions; edited summaries are excluded.</p></div>
      <Switch aria-label="Suggest speaker names after AI summary" checked={enabled} disabled={!ready || busy} onCheckedChange={value => void save(value)} />
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-af-danger">{error}</p>}
  </section>;
}
