import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { convertFileSrc } from '@tauri-apps/api/core';

export const trace: Record<string, unknown>[] = [];
let phase = 'boot';
export const record = (kind: string, details: Record<string, unknown> = {}) =>
  trace.push({ sequence: trace.length, at: performance.now(), phase, kind, ...details });
export function mark(next: string, clear = false) {
  if (clear) trace.length = 0;
  phase = next;
  record('mark');
}

// Explicit host mock. No image decoding, drawing, generation or native file operations.
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
const convertFixtureFileSrc: typeof convertFileSrc = () =>
  'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="30" height="20"%3E%3C/svg%3E';
if (
  !('__TAURI_INTERNALS__' in window) ||
  typeof window.__TAURI_INTERNALS__ !== 'object' ||
  window.__TAURI_INTERNALS__ === null
)
  throw new Error('mockWindows did not install Tauri host internals');
Object.assign(window.__TAURI_INTERNALS__, { convertFileSrc: convertFixtureFileSrc });
mockIPC(
  (cmd, args) => {
    record('hostMock', { cmd, args });
    switch (cmd) {
      case 'list_luts':
        return [];
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
  'mousedown',
  'mouseup',
  'click',
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
        tab: target?.closest?.('[data-layout-tab]')?.getAttribute('data-tab-id'),
        key: keyboard.key,
        code: keyboard.code,
        x: mouse.clientX,
        y: mouse.clientY,
        value: target instanceof HTMLInputElement ? target.value : undefined,
      });
    },
    true,
  );
}
window.addEventListener('error', (event) => record('windowError', { message: event.message }));
window.addEventListener('unhandledrejection', (event) => record('rejection', { message: String(event.reason) }));
