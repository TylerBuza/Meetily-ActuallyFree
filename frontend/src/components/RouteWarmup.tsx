'use client';

/**
 * Gets the main pages ready shortly after launch so opening one is instant.
 * A production build prefetches them. The dev server compiles a page the first
 * time it is requested, so there each page is requested once in the background
 * instead of on the first click.
 */
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const ROUTES = ['/', '/meeting-details', '/meetings', '/groups', '/contacts', '/person', '/settings'];
const START_DELAY = 2500;
const STEP = 400;

export function RouteWarmup() {
  const router = useRouter();

  useEffect(() => {
    const timers: number[] = [];
    timers.push(
      window.setTimeout(() => {
        ROUTES.forEach((route, index) => {
          timers.push(
            window.setTimeout(() => {
              if (process.env.NODE_ENV === 'development') {
                void fetch(route, { credentials: 'same-origin' }).catch(() => undefined);
              } else {
                router.prefetch(route);
              }
            }, index * STEP),
          );
        });
      }, START_DELAY),
    );
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [router]);

  return null;
}
