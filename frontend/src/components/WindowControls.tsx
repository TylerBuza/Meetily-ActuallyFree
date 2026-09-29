'use client';

/**
 * Minimize, maximize or restore, and close, for the main window on Windows,
 * where the app draws its own title bar (see lib/window-chrome). The glyphs
 * follow the Windows 11 caption buttons; colours follow the theme and close
 * turns red on hover.
 */
import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { cn } from '@/lib/utils';
import { useCustomChrome } from '@/hooks/useCustomChrome';

const glyph = 'h-[10px] w-[10px]';

const MinimizeGlyph = () => (
  <svg viewBox="0 0 10 10" className={glyph} aria-hidden>
    <path d="M0 5.5h10" stroke="currentColor" />
  </svg>
);

const MaximizeGlyph = () => (
  <svg viewBox="0 0 10 10" className={glyph} aria-hidden>
    <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" />
  </svg>
);

const RestoreGlyph = () => (
  <svg viewBox="0 0 10 10" className={glyph} aria-hidden>
    <path d="M2.5 2.5v-.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5v4A1.5 1.5 0 0 1 8 7.5h-.5" fill="none" stroke="currentColor" />
    <rect x="0.5" y="2.5" width="7" height="7" rx="1.5" fill="none" stroke="currentColor" />
  </svg>
);

const CloseGlyph = () => (
  <svg viewBox="0 0 10 10" className={glyph} aria-hidden>
    <path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" />
  </svg>
);

const button =
  'flex h-full w-[46px] items-center justify-center text-af-text-2 transition-colors duration-100 focus-visible:outline-none';

export default function WindowControls() {
  const show = useCustomChrome();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!show) return;
    const win = getCurrentWindow();
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      win
        .isMaximized()
        .then((value) => !cancelled && setMaximized(value))
        .catch(() => undefined);
    };
    sync();
    win
      .onResized(sync)
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [show]);

  if (!show) return null;

  return (
    // pointer-events-auto keeps the buttons usable while a modal dialog is open.
    <div role="group" aria-label="Window" className="pointer-events-auto fixed right-0 top-0 z-[100] flex h-[var(--af-chrome-h)]">
      <button
        type="button"
        aria-label="Minimize"
        onClick={() => void getCurrentWindow().minimize()}
        className={cn(button, 'hover:bg-af-hover hover:text-af-text focus-visible:bg-af-hover active:bg-af-active')}
      >
        <MinimizeGlyph />
      </button>
      <button
        type="button"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void getCurrentWindow().toggleMaximize()}
        className={cn(button, 'hover:bg-af-hover hover:text-af-text focus-visible:bg-af-hover active:bg-af-active')}
      >
        {maximized ? <RestoreGlyph /> : <MaximizeGlyph />}
      </button>
      <button
        type="button"
        aria-label="Close"
        onClick={() => void getCurrentWindow().close()}
        className={cn(button, 'hover:bg-[#c42b1c] hover:text-white focus-visible:bg-[#c42b1c] focus-visible:text-white active:bg-[#b22a1c]')}
      >
        <CloseGlyph />
      </button>
    </div>
  );
}
