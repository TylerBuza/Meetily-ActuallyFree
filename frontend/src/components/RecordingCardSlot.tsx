'use client';

import type { ReactNode } from 'react';

/**
 * Centers the recording bar, and every card that replaces it, in the open
 * area between the rail and the speakers panel, with a small gap so it does
 * not sit on either one. The card itself stays as wide as its contents.
 */
export function RecordingCardSlot({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none fixed bottom-12 left-0 right-0 z-40">
      <div
        className="af-recording-slot flex justify-center transition-[margin] duration-[400ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
        style={{
          marginLeft: 'calc(var(--af-sidebar-width, 16rem) + 0.5rem)',
          marginRight: 'calc(var(--af-speakers-width, 0px) + 0.5rem)',
        }}
      >
        <div className="af-appear pointer-events-none flex w-full max-w-[42rem] justify-center" style={{ '--af-i': 2 } as React.CSSProperties}>
          {children}
        </div>
      </div>
    </div>
  );
}
