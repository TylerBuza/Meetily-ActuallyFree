"use client";

import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const suggestions = [
  'Focus on action items and owners',
  'Keep it short - 5 bullet points max',
  'Highlight decisions and open questions',
  'Use speaker names from the transcript',
];

export function SummaryRegenerationDialog({
  open,
  onOpenChange,
  initialContext = '',
  speakerNamesChanged = false,
  onRegenerate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialContext?: string;
  speakerNamesChanged?: boolean;
  onRegenerate: (context: string) => Promise<void>;
}) {
  const [context, setContext] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) setContext(initialContext);
  }, [open, initialContext]);

  const submit = async () => {
    setSubmitting(true);
    try {
      await onRegenerate(context.trim());
      onOpenChange(false);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !submitting && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles size={18} className="text-blue-500" />
            {speakerNamesChanged ? 'Update summary with speaker names?' : 'Regenerate summary'}
          </DialogTitle>
          <DialogDescription>
            {speakerNamesChanged
              ? 'The transcript now has updated speaker names. Regenerate the summary to use that name context.'
              : 'Add more context or instructions for this regeneration, or leave it blank to regenerate normally.'}
          </DialogDescription>
        </DialogHeader>

        <textarea
          autoFocus
          value={context}
          onChange={(event) => setContext(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="e.g. Focus on decisions and next steps; ignore small talk"
          rows={4}
          className="w-full resize-none rounded-md border border-[var(--af-border)] bg-[var(--af-panel-2)] px-3 py-2 text-sm text-[var(--af-text)] outline-none focus:ring-2 focus:ring-blue-500"
        />

        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => setContext((current) => current.trim() ? `${current.trim()}\n${suggestion}` : suggestion)}
              className="rounded-full border border-[var(--af-border)] px-2.5 py-1 text-xs text-[var(--af-text-2)] transition-colors hover:border-blue-400 hover:text-blue-400"
            >
              + {suggestion}
            </button>
          ))}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" disabled={submitting} onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button type="button" disabled={submitting} onClick={() => void submit()}>
            {submitting ? 'Starting...' : context.trim() ? 'Regenerate with context' : 'Regenerate'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
