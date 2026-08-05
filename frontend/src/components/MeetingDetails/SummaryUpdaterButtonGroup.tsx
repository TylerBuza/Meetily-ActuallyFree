"use client";

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Copy, Save, Loader2, Search, FolderOpen, Download } from 'lucide-react';
import Analytics from '@/lib/analytics';
import type { ExportFormat } from '@/lib/exportSummary';

interface SummaryUpdaterButtonGroupProps {
  isSaving: boolean;
  isDirty: boolean;
  onSave: () => Promise<void>;
  onCopy: () => Promise<void>;
  onExport?: (format: ExportFormat) => Promise<void>;
  onFind?: () => void;
  onOpenFolder: () => Promise<void>;
  hasSummary: boolean;
}

export function SummaryUpdaterButtonGroup({
  isSaving,
  isDirty,
  onSave,
  onCopy,
  onExport,
  onFind,
  onOpenFolder,
  hasSummary
}: SummaryUpdaterButtonGroupProps) {
  const [exportOpen, setExportOpen] = useState(false);

  const doExport = async (format: ExportFormat) => {
    setExportOpen(false);
    Analytics.trackButtonClick(`export_summary_${format}`, 'meeting_details');
    if (onExport) await onExport(format);
  };

  return (
    <ButtonGroup>
      {/* Save button */}
      <Button
        variant="outline"
        size="sm"
        className={`${isDirty ? 'bg-green-200' : ""}`}
        title={isSaving ? "Saving" : "Save Changes"}
        onClick={() => {
          Analytics.trackButtonClick('save_changes', 'meeting_details');
          onSave();
        }}
        disabled={isSaving}
      >
        {isSaving ? (
          <>
            <Loader2 className="animate-spin" />
            <span className="hidden lg:inline">Saving...</span>
          </>
        ) : (
          <>
            <Save />
            <span className="hidden lg:inline">Save</span>
          </>
        )}
      </Button>

      {/* Copy button */}
      <Button
        variant="outline"
        size="sm"
        title="Copy Summary"
        onClick={() => {
          Analytics.trackButtonClick('copy_summary', 'meeting_details');
          onCopy();
        }}
        disabled={!hasSummary}
        className="cursor-pointer"
      >
        <Copy />
        <span className="hidden lg:inline">Copy</span>
      </Button>

      {/* Export dropdown (Markdown / PDF / DOCX) */}
      {onExport && (
        <div className="relative">
          <Button
            variant="outline"
            size="sm"
            title="Export summary"
            onClick={() => setExportOpen((o) => !o)}
            disabled={!hasSummary}
            className="cursor-pointer"
          >
            <Download />
            <span className="hidden lg:inline">Export</span>
          </Button>
          {exportOpen && hasSummary && (
            <>
              <div className="fixed inset-0 z-30" onClick={() => setExportOpen(false)} />
              <div className="absolute right-0 z-40 mt-1 w-40 overflow-hidden rounded-md border border-gray-200 bg-white shadow-lg">
                <button className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-100" onClick={() => doExport('pdf')}>PDF (.pdf)</button>
                <button className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-100" onClick={() => doExport('docx')}>Word (.docx)</button>
                <button className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-100" onClick={() => doExport('markdown')}>Markdown (.md)</button>
                <button className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-100" onClick={() => doExport('txt')}>Text (.txt)</button>
                <button className="block w-full px-3 py-2 text-left text-sm hover:bg-gray-100" onClick={() => doExport('json')}>JSON (.json)</button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Find button */}
      {/* {onFind && (
        <Button
          variant="outline"
          size="sm"
          title="Find in Summary"
          onClick={() => {
            Analytics.trackButtonClick('find_in_summary', 'meeting_details');
            onFind();
          }}
          disabled={!hasSummary}
          className="cursor-pointer"
        >
          <Search />
          <span className="hidden lg:inline">Find</span>
        </Button>
      )} */}
    </ButtonGroup>
  );
}
