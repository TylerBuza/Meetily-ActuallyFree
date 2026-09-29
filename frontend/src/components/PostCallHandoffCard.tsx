'use client';

import type { ReactNode } from 'react';
import { Users } from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { RecordingCardSlot } from '@/components/RecordingCardSlot';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

/**
 * Stopping and saving use the recording dock. Speaker choices opt into a
 * compact modal; their busy progress returns to the dock without an overlay or
 * focus trap so the meeting remains usable while processing continues.
 */
export function PostCallHandoffCard({
  title,
  detail,
  busy = false,
  icon,
  children,
  centered = false,
}: {
  title: string;
  detail?: string;
  busy?: boolean;
  icon?: ReactNode;
  children?: ReactNode;
  /** Center choices/errors; busy progress stays compact in the nonmodal dock. */
  centered?: boolean;
}) {
  if (centered && !busy) {
    return (
      <Dialog open>
        <DialogContent
          className="max-w-sm gap-4 p-5"
          showCloseButton={false}
          onEscapeKeyDown={(event) => event.preventDefault()}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-af-accent/[0.12] text-af-accent">
              {busy ? <Spinner size={18} /> : icon ?? <Users size={18} strokeWidth={1.75} />}
            </span>
            <div className="min-w-0">
              <DialogTitle className="text-sm">{title}</DialogTitle>
              {detail && <DialogDescription className="mt-1 text-xs">{detail}</DialogDescription>}
            </div>
          </div>
          {children}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <RecordingCardSlot>
      <div className={cn(
        'pointer-events-auto w-full animate-af-rise rounded-[26px] border border-af-border-strong bg-af-elevated/95 px-5 py-4 text-af-text shadow-2xl backdrop-blur-xl',
        centered ? 'max-w-sm' : 'max-w-[36rem]',
      )}>
        <div className="flex items-center gap-3">
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-af-accent/[0.12] text-af-accent">
            {busy ? <Spinner size={18} /> : icon ?? <Users size={18} strokeWidth={1.75} />}
          </span>
          <div className="min-w-0 text-left leading-tight">
            <div className="text-sm font-semibold tracking-tight">{title}</div>
            {detail && <div className="mt-0.5 text-xs text-af-text-3">{detail}</div>}
          </div>
        </div>
        {children && <div className="mt-4">{children}</div>}
      </div>
    </RecordingCardSlot>
  );
}
