'use client';

import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/** One deletion choice shared by the library, sidebar, and meeting page. */
export function DeleteMeetingsDialog({ open, onOpenChange, count, onDelete }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  count: number;
  onDelete: (deleteLocalFiles: boolean) => Promise<boolean>;
}) {
  const [working, setWorking] = useState(false);
  const remove = async (deleteLocalFiles: boolean) => {
    setWorking(true);
    try {
      if (await onDelete(deleteLocalFiles)) onOpenChange(false);
    } finally {
      setWorking(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !working && onOpenChange(next)}>
      <DialogContent className="max-w-md" showCloseButton={false}>
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-af-danger/[0.12] text-af-danger"><AlertTriangle className="h-4 w-4" /></span>
            <div className="min-w-0 space-y-1">
              <DialogTitle>{count === 1 ? 'Delete this meeting?' : `Delete ${count} meetings?`}</DialogTitle>
              <DialogDescription>Choose whether to keep the recording folders. The Meetily transcript, summary, notes, and action items are removed either way.</DialogDescription>
            </div>
          </div>
        </DialogHeader>
        <div className="space-y-2 text-xs text-af-text-3">
          <p><strong className="text-af-text">Remove from Meetily:</strong> Keep the local audio, transcript files, images, and other files in the recordings folder.</p>
          <p><strong className="text-af-text">Delete local files too:</strong> Permanently remove the meeting’s recording folder and its contents.</p>
        </div>
        <DialogFooter className="flex-wrap gap-2">
          <Button variant="ghost" disabled={working} onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="secondary" disabled={working} onClick={() => void remove(false)}>Remove, keep files</Button>
          <Button variant="danger" loading={working} onClick={() => void remove(true)}>Delete files too</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
