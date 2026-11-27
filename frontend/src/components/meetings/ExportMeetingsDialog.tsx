'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Overline } from '@/components/ui/surface';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EXPORT_PARTS, exportMeetings, type ExportPart, type ExportableMeeting } from '@/lib/meeting-export';
import type { ExportFormat } from '@/lib/exportSummary';
import { useI18n, type MessageKey } from '@/i18n';

const FORMATS: Array<{ id: ExportFormat; label: MessageKey; hint: MessageKey }> = [
  { id: 'pdf', label: 'home.formatPdf', hint: 'home.formatPdfHint' },
  { id: 'docx', label: 'home.formatWord', hint: 'home.formatWordHint' },
  { id: 'markdown', label: 'home.formatMarkdown', hint: 'home.formatMarkdownHint' },
  { id: 'txt', label: 'home.formatText', hint: 'home.formatTextHint' },
  { id: 'json', label: 'home.formatJson', hint: 'home.formatJsonHint' },
];

/** `EXPORT_PARTS` carries English labels; this dialog renders the translated ones. */
const PART_LABELS: Record<ExportPart, MessageKey> = {
  notes: 'home.exportPartNotes',
  actions: 'home.exportPartActions',
  summary: 'home.exportPartSummary',
  transcript: 'home.exportPartTranscript',
};

/** Exports several meetings into one document, one section per meeting. */
export function ExportMeetingsDialog({
  open,
  onOpenChange,
  meetings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meetings: ExportableMeeting[];
}) {
  const { t } = useI18n();
  const [parts, setParts] = useState<Set<ExportPart>>(() => new Set<ExportPart>(['notes', 'actions', 'summary']));
  const [format, setFormat] = useState<ExportFormat>('pdf');
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  useEffect(() => {
    if (open) setProgress(null);
  }, [open]);

  const toggle = (part: ExportPart, on: boolean) =>
    setParts((current) => {
      const next = new Set(current);
      if (on) next.add(part);
      else next.delete(part);
      return next;
    });

  const count = meetings.length;
  const busy = progress !== null;

  const run = async () => {
    setProgress({ done: 0, total: count });
    try {
      const saved = await exportMeetings(meetings, parts, format, (done, total) => setProgress({ done, total }));
      if (saved) {
        toast.success(count === 1 ? t('home.meetingExported') : t('home.meetingsExported', { count }));
        onOpenChange(false);
      }
    } catch (error) {
      toast.error(t('home.exportFailed'), { description: error instanceof Error ? error.message : String(error) });
    } finally {
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {count === 1 ? t('home.exportThisMeeting') : t('home.exportMeetingsTitle', { count })}
          </DialogTitle>
          <DialogDescription>
            {count === 1 ? t('home.exportOneDescription') : t('home.exportManyDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <div>
            <Overline className="mb-2">{t('home.include')}</Overline>
            <div className="grid grid-cols-2 gap-1.5">
              {EXPORT_PARTS.map((part) => (
                <label
                  key={part.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded-lg border border-af-border bg-af-panel-2/60 px-3 py-2 text-[13px] text-af-text-2 transition-colors hover:border-af-border-strong hover:text-af-text"
                >
                  <Checkbox checked={parts.has(part.id)} onCheckedChange={(checked) => toggle(part.id, checked === true)} />
                  {t(PART_LABELS[part.id])}
                </label>
              ))}
            </div>
          </div>

          <div>
            <Overline className="mb-2">{t('home.format')}</Overline>
            <div role="radiogroup" aria-label={t('home.format')} className="grid grid-cols-3 gap-1.5">
              {FORMATS.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={format === option.id}
                  onClick={() => setFormat(option.id)}
                  className={cn(
                    'rounded-lg border px-3 py-2 text-left transition-[background-color,border-color,color] active:scale-[0.98]',
                    format === option.id
                      ? 'border-af-accent bg-af-accent/[0.1] text-af-text'
                      : 'border-af-border bg-af-panel-2/60 text-af-text-2 hover:border-af-border-strong hover:text-af-text',
                  )}
                >
                  <span className="block text-[13px] font-medium">{t(option.label)}</span>
                  <span className="block text-[11px] text-af-text-4">{t(option.hint)}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void run()} loading={busy} disabled={parts.size === 0 || count === 0}>
            {busy && progress && progress.total > 1
              ? t('home.preparingProgress', { done: progress.done, total: progress.total })
              : t('home.export')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
