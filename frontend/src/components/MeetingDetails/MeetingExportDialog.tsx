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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { LinkStyle } from '@/lib/exportMarkdownFrontmatter';
import { useI18n } from '@/i18n';
import type { MessageKey } from '@/i18n';

const contentOptions: Array<{ value: MeetingExportContent; label: MessageKey; description: MessageKey }> = [
  { value: 'transcript', label: 'meeting.exportContentTranscript', description: 'meeting.exportContentTranscriptDescription' },
  { value: 'summary', label: 'meeting.exportContentSummary', description: 'meeting.exportContentSummaryDescription' },
  { value: 'both', label: 'meeting.exportContentBoth', description: 'meeting.exportContentBothDescription' },
];

const formatOptions: Array<{
  value: MeetingExportFormat;
  label: MessageKey;
  description: MessageKey;
  icon: typeof FileText;
}> = [
  { value: 'pdf', label: 'meeting.formatPdf', description: 'meeting.formatPdfDescription', icon: FileText },
  { value: 'docx', label: 'meeting.formatWord', description: 'meeting.formatWordDescription', icon: FileType },
  { value: 'txt', label: 'meeting.formatText', description: 'meeting.formatTextDescription', icon: ScrollText },
  { value: 'markdown', label: 'meeting.formatMarkdown', description: 'meeting.formatMarkdownDescription', icon: Files },
  { value: 'json', label: 'meeting.formatJson', description: 'meeting.formatJsonDescription', icon: FileJson },
  { value: 'clipboard', label: 'meeting.formatClipboard', description: 'meeting.formatClipboardDescription', icon: Clipboard },
];

const LINK_STYLE_STORAGE_KEY = 'meetily_export_link_style';

const linkStyleOptions: Array<{ value: LinkStyle; label: MessageKey; description: MessageKey }> = [
  { value: 'generic', label: 'meeting.linkStyleGeneric', description: 'meeting.linkStyleGenericDescription' },
  { value: 'obsidian', label: 'meeting.linkStyleObsidian', description: 'meeting.linkStyleObsidianDescription' },
];

function loadStoredLinkStyle(): LinkStyle {
  if (typeof window === 'undefined') return 'generic';
  try { return window.localStorage.getItem(LINK_STYLE_STORAGE_KEY) === 'obsidian' ? 'obsidian' : 'generic'; }
  catch { return 'generic'; }
}

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
  onExport: (content: MeetingExportContent, format: MeetingExportFormat, linkStyle: LinkStyle) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const [step, setStep] = useState<'content' | 'format'>('content');
  const [content, setContent] = useState<MeetingExportContent>('both');
  const [exporting, setExporting] = useState(false);
  const [linkStyle, setLinkStyle] = useState<LinkStyle>('generic');

  useEffect(() => {
    if (!open) return;
    setStep('content');
    setContent(hasTranscript && hasSummary ? 'both' : hasTranscript ? 'transcript' : 'summary');
    setExporting(false);
    setLinkStyle(loadStoredLinkStyle());
  }, [open, hasTranscript, hasSummary]);

  const isAvailable = (value: MeetingExportContent) => {
    if (value === 'transcript') return hasTranscript;
    if (value === 'summary') return hasSummary;
    return hasTranscript && hasSummary;
  };

  const selectLinkStyle = (value: LinkStyle) => {
    setLinkStyle(value);
    if (typeof window !== 'undefined') {
      try { window.localStorage.setItem(LINK_STYLE_STORAGE_KEY, value); } catch { /* Export still works without preference storage. */ }
    }
  };

  const exportAs = async (format: MeetingExportFormat) => {
    setExporting(true);
    const succeeded = await onExport(content, format, linkStyle);
    setExporting(false);
    if (succeeded) onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !exporting && onOpenChange(nextOpen)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{step === 'content' ? t('meeting.exportWhatTitle') : t('meeting.exportHowTitle')}</DialogTitle>
          <DialogDescription>
            {step === 'content'
              ? t('meeting.exportDefaultDescription')
              : content === 'both'
                ? t('meeting.chooseFormatBoth')
                : content === 'transcript'
                  ? t('meeting.chooseFormatTranscript')
                  : t('meeting.chooseFormatSummary')}
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
                  <span className="block text-sm font-semibold">{t(option.label)}</span>
                  <span className="block text-xs font-normal opacity-70">
                    {isAvailable(option.value) ? t(option.description) : t('meeting.notAvailableForMeeting')}
                  </span>
                </span>
              </Button>
            ))}
          </div>
        ) : (
          <>
            <div className="mb-3">
              <label htmlFor="export-link-style" className="mb-1 block text-xs font-medium opacity-70">
                {t('meeting.markdownLinkStyle')}
              </label>
              <Select value={linkStyle} onValueChange={(value) => selectLinkStyle(value as LinkStyle)}>
                <SelectTrigger id="export-link-style">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {linkStyleOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.label)} — {t(option.description)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
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
                      <span className="block text-sm font-semibold">{t(option.label)}</span>
                      <span className="block text-[11px] font-normal opacity-70">{t(option.description)}</span>
                    </span>
                  </Button>
                );
              })}
            </div>
          </>
        )}

        <DialogFooter>
          {step === 'format' && (
            <Button type="button" variant="outline" disabled={exporting} onClick={() => setStep('content')}>
              {t('meeting.back')}
            </Button>
          )}
          {step === 'content' && (
            <Button type="button" disabled={!isAvailable(content)} onClick={() => setStep('format')}>
              {t('meeting.chooseFormat')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
