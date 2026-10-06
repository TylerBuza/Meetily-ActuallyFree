"use client";
import { hasAISpeakerName, type AISpeakerNames } from '@/lib/summary-speaker-names';
export function AISpeakerHint({speaker, names, onReview}: {speaker:string; names:AISpeakerNames; onReview?:()=>void}) {
  if (!hasAISpeakerName(speaker, names)) return null;
  return <span className="flex flex-wrap items-center gap-1 text-[10px] text-af-text-3">
    <span title="Unverified name suggested by the AI summary. This is not a saved contact or voice match." className="rounded border border-af-border px-1">AI · unsaved</span>
    {onReview && <button type="button" onClick={onReview} className="rounded px-1 text-af-accent hover:bg-af-hover">Save name</button>}
  </span>;
}
