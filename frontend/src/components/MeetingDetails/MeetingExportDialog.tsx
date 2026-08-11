"use client";

import { useEffect, useState } from 'react';
import { Clipboard, FileJson, FileText, FileType, Files, ScrollText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { MeetingExportContent, MeetingExportFormat } from '@/hooks/meeting-details/useCopyOperations';

const contentOptions: Array<{ value: MeetingExportContent; label: string; description: string }> = [
  { value: 'transcript', label: 'Transcript', description: 'Everything said, with timestamps' },
  { value: 'summary', label: 'Summary', description: 'The current AI meeting summary' },
  { value: 'both', label: 'Transcript + Summary', description: 'A complete meeting record' },
];

const formatOptions: Array<{
  value: MeetingExportFormat;
  label: string;
  description: string;
  icon: typeof FileText;
}> = [
  { value: 'pdf', label: 'PDF', description: 'Ready to share or print', icon: FileText },
  { value: 'docx', label: 'Word', description: 'Editable .docx document', icon: FileType },
  { value: 'txt', label: 'Text', description: 'Plain .txt file', icon: ScrollText },
  { value: 'markdown', label: 'Markdown', description: 'Formatted .md file', icon: Files },
  { value: 'json', label: 'JSON', description: 'Rendered content as JSON', icon: FileJson },
  { value: 'clipboard', label: 'Clipboard', description: 'Copy formatted content', icon: Clipboard },
];

export function MeetingExportDialog({
  open,
  onOpenChange,
  hasTranscript,
  hasSummary,
  onExport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasTranscript: boolean;
  hasSummary: boolean;
  onExport: (content: MeetingExportContent, format: MeetingExportFormat) => Promise<boolean>;
}) {
  const [step, setStep] = useState<'content' | 'format'>('content');
  const [content, setContent] = useState<MeetingExportContent>('both');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStep('content');
    setContent(hasTranscript && hasSummary ? 'both' : hasTranscript ? 'transcript' : 'summary');
    setExporting(false);
  }, [open, hasTranscript, hasSummary]);

  const isAvailable = (value: MeetingExportContent) => {
    if (value === 'transcript') return hasTranscript;
    if (value === 'summary') return hasSummary;
    return hasTranscript && hasSummary;
  };

  const exportAs = async (format: MeetingExportFormat) => {
    setExporting(true);
    const succeeded = await onExport(content, format);
    setExporting(false);
    if (succeeded) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !exporting && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{step === 'content' ? 'What do you want to export?' : 'How should it be exported?'}</DialogTitle>
          <DialogDescription>
            {step === 'content'
              ? 'Transcript + Summary is selected by default for a complete meeting record.'
              : `Choose a format for the ${content === 'both' ? 'transcript and summary' : content}.`}
          </DialogDescription>
        </DialogHeader>

        {step === 'content' ? (
          <div className="grid gap-2">
            {contentOptions.map((option) => (
              <Button
                key={option.value}
                type="button"
                variant={content === option.value ? 'default' : 'outline'}
                className="h-auto justify-start px-4 py-3 text-left"
                disabled={!isAvailable(option.value)}
                onClick={() => setContent(option.value)}
              >
                <span>
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="block text-xs font-normal opacity-70">
                    {isAvailable(option.value) ? option.description : 'Not available for this meeting'}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-2">
            {formatOptions.map((option) => {
              const Icon = option.icon;
              return (
                <Button
                  key={option.value}
                  type="button"
                  variant="outline"
                  className="h-auto justify-start px-3 py-3 text-left"
                  disabled={exporting}
                  onClick={() => void exportAs(option.value)}
                >
                  <Icon size={17} />
                  <span>
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className="block text-[11px] font-normal opacity-70">{option.description}</span>
                  </span>
                </Button>
              );
            })}
          </div>
        )}

        <DialogFooter>
          {step === 'format' && (
            <Button type="button" variant="outline" disabled={exporting} onClick={() => setStep('content')}>
              Back
            </Button>
          )}
          {step === 'content' && (
            <Button type="button" disabled={!isAvailable(content)} onClick={() => setStep('format')}>
              Choose format
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
