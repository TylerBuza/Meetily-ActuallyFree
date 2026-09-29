'use client';

import React from 'react';
import { usePathname } from 'next/navigation';
import { useCustomChrome } from '@/hooks/useCustomChrome';

interface MainContentProps {
  children: React.ReactNode;
}

const MainContent: React.FC<MainContentProps> = ({ children }) => {
  const pathname = usePathname();
  const customChrome = useCustomChrome();

  return (
    // min-w-0 is required: flex items default to min-width:auto and will not
    // shrink below their content, which clipped Settings (and other pages)
    // when the window was narrower than sidebar + content.
    // Every page sits flush against the rail divider in the panel color, so
    // the title strip and the page read as one surface. An inset here showed
    // the darker canvas as its own strip.
    <main
      className="relative z-30 flex h-screen min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--af-panel)] transition-[margin-left] duration-300 ease-[cubic-bezier(0.22,1.25,0.36,1)] motion-reduce:transition-none"
      style={{ marginLeft: 'var(--af-sidebar-width, 16rem)' }}
    >
      {/* The app's own title strip on Windows: drag to move, double-click to
          maximize. The window buttons sit over its right end. */}
      {customChrome && <div data-tauri-drag-region aria-hidden className="h-[var(--af-chrome-h)] shrink-0" />}
      {/* Keyed by page so each page fades in when opened. Opacity only: a
          transform here would move the fixed record card while it runs. */}
      <div key={pathname} className="af-page-enter min-h-0 min-w-0 flex-1 overflow-hidden">
        {children}
      </div>
    </main>
  );
};

export default MainContent;
