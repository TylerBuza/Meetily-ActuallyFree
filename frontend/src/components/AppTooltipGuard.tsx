'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { tooltipSurface } from '@/components/ui/tooltip';

type Tip = { text: string; x: number; y: number; below: boolean };

function tipText(el: HTMLElement | null): { el: HTMLElement; text: string } | null {
  let node = el;
  while (node && node !== document.body) {
    const native = node.getAttribute('title');
    const stored = node.getAttribute('data-af-tip');
    const text = (native || stored || '').trim();
    if (text) return { el: node, text };
    node = node.parentElement;
  }
  return null;
}

function holdNativeTitle(el: HTMLElement) {
  const native = el.getAttribute('title');
  if (native == null) return;
  el.setAttribute('data-af-tip', native);
  el.removeAttribute('title');
}

/**
 * Browser title attributes draw the Windows tooltip. This keeps that text and
 * shows it in the same tooltip used by the rest of the app.
 */
export function AppTooltipGuard() {
  const [tip, setTip] = useState<Tip | null>(null);

  useEffect(() => {
    let showTimer = 0;
    let holdTimer = 0;
    let current: HTMLElement | null = null;

    const place = (el: HTMLElement, text: string) => {
      const rect = el.getBoundingClientRect();
      const below = rect.top < 40;
      setTip({
        text,
        x: rect.left + rect.width / 2,
        y: below ? rect.bottom + 6 : rect.top - 6,
        below,
      });
    };

    const clear = () => {
      window.clearTimeout(showTimer);
      window.clearInterval(holdTimer);
      current = null;
      setTip(null);
    };

    const onOver = (event: PointerEvent) => {
      const hit = tipText(event.target as HTMLElement | null);
      if (!hit) {
        clear();
        return;
      }
      if (hit.el === current) return;
      clear();
      current = hit.el;
      holdNativeTitle(hit.el);
      holdTimer = window.setInterval(() => holdNativeTitle(hit.el), 200);
      showTimer = window.setTimeout(() => place(hit.el, hit.text), 400);
    };

    const onOut = (event: PointerEvent) => {
      if (!current) return;
      const next = event.relatedTarget;
      if (next instanceof Node && current.contains(next)) return;
      clear();
    };

    document.addEventListener('pointerover', onOver);
    document.addEventListener('pointerout', onOut);
    document.addEventListener('scroll', clear, true);
    return () => {
      clear();
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerout', onOut);
      document.removeEventListener('scroll', clear, true);
    };
  }, []);

  if (!tip || typeof document === 'undefined') return null;

  // The outer box owns placement; the inner one animates, so the entrance
  // transform never fights the centering translate.
  return createPortal(
    <div
      className="pointer-events-none fixed z-[80]"
      style={{
        left: tip.x,
        top: tip.y,
        transform: tip.below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)',
      }}
    >
      <div role="tooltip" className={cn(tooltipSurface, 'animate-af-pop')}>
        {tip.text}
      </div>
    </div>,
    document.body,
  );
}
