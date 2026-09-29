'use client';

/**
 * Whether the app draws its own title bar (see lib/window-chrome), kept in
 * step with the class on <html>. The boot script sets that class before the
 * first paint, but a full client re-render of the document (after a hydration
 * mismatch, say) or a page loaded before the script existed can drop it, and
 * then the drag strip and window buttons would vanish. This puts it back.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { CUSTOM_CHROME_CLASS, hasCustomChrome } from '@/lib/window-chrome';

// Settled once Tauri confirms whether the window has a system title bar.
let decorated: boolean | null = null;

function expectsCustomChrome(): boolean {
  if (decorated !== null) return !decorated;
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window && /Windows/i.test(navigator.userAgent);
}

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

export function useCustomChrome(): boolean {
  const custom = useSyncExternalStore(subscribe, hasCustomChrome, () => false);

  useEffect(() => {
    if (!custom && expectsCustomChrome()) document.documentElement.classList.add(CUSTOM_CHROME_CLASS);
  }, [custom]);

  useEffect(() => {
    if (decorated !== null || !('__TAURI_INTERNALS__' in window)) return;
    import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().isDecorated())
      .then((value) => {
        if (typeof value !== 'boolean') return;
        decorated = value;
        if (value) document.documentElement.classList.remove(CUSTOM_CHROME_CLASS);
        else document.documentElement.classList.add(CUSTOM_CHROME_CLASS);
      })
      .catch(() => undefined);
  }, []);

  return custom;
}
