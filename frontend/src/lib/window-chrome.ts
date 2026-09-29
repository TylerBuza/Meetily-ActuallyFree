/**
 * On Windows the main window has no system title bar (decorations are off in
 * tauri.windows.conf.json). The app draws its own: a drag strip across the top
 * of the main pane and the minimize, maximize and close buttons in the corner.
 *
 * The boot script marks <html> before the first paint so the layout never
 * jumps; CSS reads --af-chrome-h (0 elsewhere) to make room for the strip.
 */
export const CUSTOM_CHROME_CLASS = 'af-custom-chrome';

export const CHROME_BOOT_SCRIPT = `
(function () {
  try {
    if (window.__TAURI_INTERNALS__ && /Windows/i.test(navigator.userAgent)) {
      document.documentElement.classList.add('${CUSTOM_CHROME_CLASS}');
    }
  } catch (_) {}
})();
`;

export function hasCustomChrome(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains(CUSTOM_CHROME_CLASS);
}
