'use client';

import { CheckCircle2 } from 'lucide-react';
import { useOptionalModelDownloads, OptionalModel } from '@/contexts/OptionalModelDownloadsContext';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Spinner } from '@/components/ui/spinner';
import { useI18n } from '@/i18n';

export function OptionalModelDownloads({ activeOnly = false, allowUninstall = false }: { activeOnly?: boolean; allowUninstall?: boolean }) {
  const { t } = useI18n();
  const { jobs, startDownload, uninstallModel } = useOptionalModelDownloads();
  const models: OptionalModel[] = ['whisper', 'nemotron'];
  const visible = models.filter(model => !activeOnly || jobs[model].status !== 'idle');
  if (!visible.length) return null;
  return (
    <section aria-label={t('models.optionalDownloadsTitle')} className="w-full space-y-3 rounded-2xl border border-af-border bg-af-panel-2/40 p-5 text-af-text">
      <div>
        <h3 className="flex items-center gap-2 text-[15px] font-semibold">
          {t('models.optionalDownloadsTitle')}
          <span className="rounded-full bg-af-accent/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-af-accent">
            {t('models.recommended')}
          </span>
        </h3>
        <p className="mt-1 text-sm text-af-text-2">
          {t('models.optionalDownloadsDescription')}
        </p>
      </div>
      {visible.map(model => {
        const job = jobs[model];
        const label = model === 'whisper' ? t('models.whisperModelLabel') : t('models.nemotronModelLabel');
        return (
          <div key={model} className="space-y-2 rounded-xl border border-af-border bg-af-panel-2 px-4 py-3">
            <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
              <span className="min-w-0 text-sm">{label}</span>
              {job.status === 'ready' && job.enabled ? (
                <span className="inline-flex shrink-0 items-center gap-1.5 text-sm font-medium text-af-success">
                  <CheckCircle2 className="h-4 w-4" /> {t('models.enabled')}
                </span>
              ) : job.status === 'uninstalling' ? (
                <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-sm text-af-text-2">
                  <Spinner className="h-3.5 w-3.5" /> {t('models.uninstalling')}
                </span>
              ) : job.status === 'activating' ? (
                <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-sm text-af-text-2">
                  <Spinner className="h-3.5 w-3.5" /> {t('models.enabling')}
                </span>
              ) : job.status === 'downloading' ? (
                <span role="status" className="shrink-0 text-sm tabular-nums text-af-text-2">{Math.round(job.progress)}%</span>
              ) : (
                <Button size="sm" variant="outline" className="shrink-0" onClick={() => startDownload(model)}>
                  {job.status === 'activation-error' ? t('models.retryActivation') : job.status === 'ready' ? t('models.enable') : job.status === 'error' ? t('models.retry') : t('models.downloadAndEnable')}
                </Button>
              )}
              {allowUninstall && (job.status === 'ready' || job.status === 'activation-error') && (
                <Button size="sm" variant="outline" title={model === 'nemotron' ? t('models.removeNemotronTitle') : t('models.removeWhisperTitle')} aria-label={t('models.uninstallModelAria', { model: model === 'whisper' ? 'Whisper' : 'Nemotron' })} onClick={() => uninstallModel(model)}>
                  {t('models.uninstall')}
                </Button>
              )}
            </div>
            {job.status === 'downloading' && <Progress value={job.progress} aria-label={t('models.downloadProgressAria', { model })} />}
            {job.error && <p role="alert" className="text-xs text-af-danger">{job.error}</p>}
          </div>
        );
      })}
    </section>
  );
}
