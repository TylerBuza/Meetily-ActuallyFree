'use client';

export const SIDEBAR_MIN = 4 * 16;
/** The normal open rail. Narrower than this snaps shut; wider is optional. */
export const SIDEBAR_DEFAULT = 16 * 16;
export const SIDEBAR_ABSOLUTE_MAX = 24 * 16;
const CARD = 27.75 * 16;
const GAP = 0.5 * 16;
/** Room kept for the recorder's side panel when it is docked. */
const SPEAKERS_CONDENSED = 11 * 16;

/** Narrowest window: collapsed rail, condensed speakers panel, and the shrunk live card. */
export const COMPACT_MIN_WIDTH = SIDEBAR_MIN + GAP + CARD + GAP + SPEAKERS_CONDENSED;

function speakersAreOpen() {
  if (typeof document === 'undefined') return false;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--af-speakers-width').trim();
  return raw !== '' && raw !== '0' && raw !== '0px';
}

/** Window width that fits this rail plus the recording card and open speakers. */
export function windowWidthForRail(railWidth: number) {
  const reserved = speakersAreOpen() ? SPEAKERS_CONDENSED : 0;
  return Math.ceil(railWidth + GAP + CARD + GAP + reserved);
}

/** Largest rail that still leaves the recording card clear. Speakers, if open, stay at the condensed width. */
export function maxSidebarFit(windowWidth: number) {
  const reserved = speakersAreOpen() ? SPEAKERS_CONDENSED : 0;
  return windowWidth - GAP - CARD - GAP - reserved;
}

/** Live drag can sit between shut and the default so the rail can squish. */
export function previewSidebarWidth(next: number, windowWidth = typeof window === 'undefined' ? 1280 : window.innerWidth) {
  const ceiling = Math.min(SIDEBAR_ABSOLUTE_MAX, Math.max(SIDEBAR_MIN, maxSidebarFit(windowWidth)));
  return Math.round(Math.max(SIDEBAR_MIN, Math.min(ceiling, next)));
}

/** Pointer travel that counts as a flick between fully shut and the default width. */
const SIDEBAR_FLICK = 36;

/**
 * A short pull from shut snaps open to the default. A short pull toward shut
 * snaps fully minimized. Wider than the default is kept, up to the window cap.
 * `origin` is the width where the drag started; without it, only the release
 * width is used (programmatic opens pass the default and stay open).
 */
export function snapSidebarWidth(
  next: number,
  windowWidth = typeof window === 'undefined' ? 1280 : window.innerWidth,
  origin?: number,
) {
  const ceiling = Math.min(SIDEBAR_ABSOLUTE_MAX, maxSidebarFit(windowWidth));
  if (ceiling < SIDEBAR_DEFAULT) return SIDEBAR_MIN;

  const fromShut = origin != null && origin <= SIDEBAR_MIN + 8;
  if (fromShut) {
    if (next < SIDEBAR_MIN + SIDEBAR_FLICK) return SIDEBAR_MIN;
    return Math.round(Math.min(ceiling, Math.max(SIDEBAR_DEFAULT, next)));
  }

  if (next < SIDEBAR_DEFAULT - SIDEBAR_FLICK) return SIDEBAR_MIN;
  return Math.round(Math.min(ceiling, Math.max(SIDEBAR_DEFAULT, next)));
}

export function displayedSidebarWidth(preferred: number, windowWidth: number) {
  const ceiling = Math.min(SIDEBAR_ABSOLUTE_MAX, maxSidebarFit(windowWidth));
  if (ceiling < SIDEBAR_DEFAULT || preferred <= SIDEBAR_MIN + 8) return SIDEBAR_MIN;
  return Math.round(Math.min(ceiling, Math.max(SIDEBAR_DEFAULT, preferred)));
}


