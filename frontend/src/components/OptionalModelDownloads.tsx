'use client';

import { CheckCircle2 } from 'lucide-react';
import { useOptionalModelDownloads, OptionalModel } from '@/contexts/OptionalModelDownloadsContext';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';

export function OptionalModelDownloads({ activeOnly = false }: { activeOnly?: boolean }) {
  const { jobs, startDownload } = useOptionalModelDownloads();
  const models: OptionalModel[] = ['whisper', 'nemotron'];
  const visible = models.filter(model => !activeOnly || jobs[model].status !== 'idle');
  if (!visible.length) return null;
  return (
    <section aria-label="Optional model downloads" className="w-full space-y-3 rounded-2xl border border-af-border bg-af-panel-2/40 p-5 text-af-text">
      <div>
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          Optional model downloads
          <span className="rounded-full bg-af-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
            Recommended
          </span>
        </h3>
        <p className="mt-1 text-sm text-af-text-2">
          Downloads continue while you use Meetily and automatically enable the model when complete. Keep the app open until downloads finish.
        </p>
      </div>
      {visible.map(model => {
        const job = jobs[model];
        const label = model === 'whisper' ? 'Whisper Large v3 Turbo Q5 · ~547 MB' : 'Nemotron-3 diarization · ~382 MB';
        return (
          <div key={model} className="space-y-2 rounded-xl border border-af-border bg-af-panel-2 px-4 py-3">
            <div className="flex min-h-8 items-center justify-between gap-3">
              <span className="min-w-0 text-sm">{label}</span>
              {job.status === 'ready' && job.enabled ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-af-success">
                  <CheckCircle2 className="h-4 w-4" /> Enabled
                </span>
              ) : job.status === 'activating' ? (
                <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-sm text-af-text-2">
                  <Spinner className="h-3.5 w-3.5" /> Enabling…
                </span>
              ) : job.status === 'downloading' ? (
                <span role="status" className="shrink-0 text-sm tabular-nums text-af-text-2">{Math.round(job.progress)}%</span>
              ) : (
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => startDownload(model)}>
                  {job.status === 'activation-error' ? 'Retry activation' : job.status === 'ready' ? 'Enable' : job.status === 'error' ? 'Retry' : 'Download & enable'}
                </Button>
              )}
            </div>
            {job.status === 'downloading' && <Progress value={job.progress} aria-label={`${model} download progress`} />}
            {job.error && <p role="alert" className="text-xs text-af-danger">{job.error}</p>}
          </div>
        );
      })}
    </section>
  );
}
