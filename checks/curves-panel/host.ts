import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { convertFileSrc } from '@tauri-apps/api/core';

export let phase = 'boot';
export const trace: Record<string, unknown>[] = [];
export const record = (kind: string, details: Record<string, unknown> = {}) =>
  trace.push({ sequence: trace.length, at: performance.now(), phase, kind, ...details });
export function mark(next: string, clear = false) {
  if (clear) trace.length = 0;
  phase = next;
  record('mark');
}

// This is a host boundary mock, never a backend/export correctness claim.
let finishExport: (() => void) | null = null;
export function releaseExport() {
  finishExport?.();
  finishExport = null;
}
mockWindows('main');
window.__TAURI_OS_PLUGIN_INTERNALS__ = {
  platform: 'windows',
  eol: '\r\n',
  os_type: 'windows',
  family: 'windows',
  version: 'fixture',
  arch: 'x86_64',
  exe_extension: 'exe',
};
if (
  !('__TAURI_INTERNALS__' in window) ||
  typeof window.__TAURI_INTERNALS__ !== 'object' ||
  window.__TAURI_INTERNALS__ === null
) {
  throw new Error('mockWindows did not install Tauri host internals');
}
const convertFixtureFileSrc: typeof convertFileSrc = () =>
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="30" height="20"%3E%3C/svg%3E';
Object.assign(window.__TAURI_INTERNALS__, { convertFileSrc: convertFixtureFileSrc });
mockIPC(
  (cmd, args) => {
    record('hostMock', { cmd, args });
    switch (cmd) {
      case 'get_image_dimensions':
        if (!args || !('path' in args) || typeof args.path !== 'string') {
          throw new Error('get_image_dimensions requires a string path');
        }
        return args.path.includes('watermark') ? { width: 400, height: 100 } : { width: 3000, height: 2000 };
      case 'estimate_export_sizes':
        return 123456;
      case 'list_luts':
        return [];
      case 'plugin:dialog|save':
        return 'C:/fixture/output.jpg';
      case 'plugin:dialog|open':
        return 'C:/fixture/watermark.png';
      case 'export_images':
        return new Promise<void>((resolve) => {
          finishExport = resolve;
        });
      case 'cancel_export':
        releaseExport();
        return null;
      case 'save_metadata_and_update_thumbnail':
      case 'save_settings':
        return null;
      default:
        record('unexpectedHost', { cmd, args });
        throw new Error(`Unconfigured host boundary: ${cmd}`);
    }
  },
  { shouldMockEvents: true },
);

for (const type of [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'mousedown',
  'mousemove',
  'mouseup',
  'click',
  'contextmenu',
  'keydown',
  'keyup',
  'input',
  'change',
  'focusin',
]) {
  window.addEventListener(
    type,
    (event) => {
      const target = event.target as Element;
      const mouse = event as MouseEvent;
      const keyboard = event as KeyboardEvent;
      record('input', {
        type,
        trusted: event.isTrusted,
        target: target?.tagName,
        panel: target?.closest?.('[data-panel]')?.getAttribute('data-panel'),
        ariaLabel: target?.getAttribute?.('aria-label'),
        key: keyboard.key,
        code: keyboard.code,
        x: mouse.clientX,
        y: mouse.clientY,
        buttons: mouse.buttons,
        value: target instanceof HTMLInputElement ? target.value : undefined,
      });
    },
    true,
  );
}
window.addEventListener('error', (event) => record('windowError', { message: event.message }));
window.addEventListener('unhandledrejection', (event) => record('rejection', { message: String(event.reason) }));
