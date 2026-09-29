import React from 'react';
import { Upload } from 'lucide-react';
import { getAudioFormatsDisplayList } from '@/constants/audioFormats';

interface ImportDropOverlayProps {
  visible: boolean;
}

/** Shown while an audio file is dragged over the window. */
export function ImportDropOverlay({ visible }: ImportDropOverlayProps) {
  if (!visible) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[var(--af-scrim-color)] backdrop-blur-sm animate-in fade-in-0 duration-200">
      <div className="rounded-3xl border-2 border-dashed border-af-accent/60 bg-af-elevated/95 px-14 py-12 text-center shadow-2xl animate-af-pop">
        <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-af-accent/[0.12] text-af-accent">
          <Upload className="h-7 w-7" />
        </span>
        <p className="text-lg font-semibold text-af-text">Drop to import this recording</p>
        <p className="mt-1.5 text-sm text-af-text-3">{getAudioFormatsDisplayList()}</p>
      </div>
    </div>
  );
}
