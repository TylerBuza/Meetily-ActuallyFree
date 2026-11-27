import React from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { UpdateInfo } from '@/services/updateService';
import { tNow } from '@/i18n';

let globalShowDialogCallback: (() => void) | null = null;

export function setUpdateDialogCallback(callback: () => void) {
  globalShowDialogCallback = callback;
}

export function showUpdateNotification(updateInfo: UpdateInfo, onUpdateClick?: () => void) {
  const handleClick = () => {
    toast.dismiss(toastId);
    if (onUpdateClick) {
      onUpdateClick();
    } else if (globalShowDialogCallback) {
      globalShowDialogCallback();
    }
  };

  const toastId = toast.info(
    <div className="flex items-center justify-between gap-4">
      <div className="flex items-center gap-2">
        <Download className="h-4 w-4" />
        <div>
          <p className="font-medium">{tNow('shell.updateAvailable')}</p>
          <p className="text-sm text-muted-foreground">
            {tNow('shell.updateAvailableVersion', { version: updateInfo.version ?? '' })}
          </p>
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          handleClick();
        }}
        className="text-sm font-medium text-af-accent hover:text-af-accent underline"
      >
        {tNow('shell.viewDetails')}
      </button>
    </div>,
    {
      duration: 10000,
    }
  );
}
