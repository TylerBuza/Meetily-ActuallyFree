'use client';

import { useOptionalModelDownloads, OptionalModel } from '@/contexts/OptionalModelDownloadsContext';
import { Button } from '@/components/ui/button';

export function OptionalModelDownloads({ activeOnly = false }: { activeOnly?: boolean }) {
  const { jobs, startDownload } = useOptionalModelDownloads();
  const models: OptionalModel[] = ['whisper', 'nemotron'];
  const visible = models.filter(model => !activeOnly || jobs[model].status !== 'idle');
  if (!visible.length) return null;
  return <section aria-label="Optional model downloads" className="w-full space-y-3 rounded-xl border border-[var(--af-border)] bg-[var(--af-panel)] p-4">
    <h3 className="font-semibold">Optional model downloads</h3>
    <p className="text-xs text-[var(--af-text-2)]">Downloads continue while you use Meetily. Choose these models in Settings once ready. Keep the app open until downloads finish.</p>
    {visible.map(model => {
      const job = jobs[model];
      const label = model === 'whisper' ? 'Whisper Large v3 Turbo Q5 · ~547 MB' : 'Nemotron-3 diarization · ~382 MB';
      return <div key={model} className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">{label}</span>
          {job.status === 'ready' ? <span className="text-sm text-emerald-600">Ready</span>
            : job.status === 'downloading' ? <span role="status" className="text-sm">{Math.round(job.progress)}%</span>
            : <Button size="sm" variant="outline" onClick={() => startDownload(model)}>{job.status === 'error' ? 'Retry' : 'Download'}</Button>}
        </div>
        {job.status === 'downloading' && <progress className="h-2 w-full" max={100} value={job.progress} aria-label={`${model} download progress`} />}
        {job.error && <p role="alert" className="text-xs text-red-500">{job.error}</p>}
      </div>;
    })}
  </section>;
}
