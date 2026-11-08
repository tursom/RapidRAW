import { mockIPC, mockWindows } from '@tauri-apps/api/mocks';
import type { convertFileSrc } from '@tauri-apps/api/core';
import type { Adjustments } from '../../src/utils/adjustments';

export const trace: Record<string, unknown>[] = [];
let phase = 'boot';
export const record = (kind: string, details: Record<string, unknown> = {}) => {
  trace.push({ sequence: trace.length, at: performance.now(), phase, kind, ...structuredClone(details) });
};
export function mark(next: string) {
  phase = next;
  record('mark');
}

// Only the native host is mocked. No image/model bytes, filesystem writes or remote requests.
const metadata = new Map<string, Adjustments>();
const held = new Map<string, (value: { adjustments: Adjustments }) => void>();
const holdPaths = new Set<string>();
let generationResult: (() => void) | null = null;
let holdCancellation = false;
let cancellationResult: (() => void) | null = null;
export function deferCancellation() {
  holdCancellation = true;
  record('mockSetup', { cancelTaskDeferred: true });
}
export function releaseCancellation() {
  if (!cancellationResult) throw new Error('No pending fixture cancel IPC');
  const resolve = cancellationResult;
  cancellationResult = null;
  holdCancellation = false;
  record('mockRelease', { cancelTaskResult: null });
  resolve();
}
export function releaseGeneration() {
  if (!generationResult) throw new Error('No pending fixture model request');
  const resolve = generationResult;
  generationResult = null;
  record('mockRelease', { modelResult: true });
  resolve();
}
export function prepareMetadata(path: string, adjustments: Adjustments, hold = false) {
  metadata.set(path, structuredClone(adjustments));
  if (hold) holdPaths.add(path);
  else holdPaths.delete(path);
  record('mockSetup', { path, hold, adjustments });
}
export function releaseMetadata(path: string) {
  const adjustments = metadata.get(path);
  const resolve = held.get(path);
  if (!adjustments || !resolve) throw new Error(`No held metadata for ${path}`);
  held.delete(path);
  holdPaths.delete(path);
  record('mockRelease', { path, adjustments });
  resolve({ adjustments: structuredClone(adjustments) });
}
export function resetHost() {
  if (generationResult) releaseGeneration();
  if (cancellationResult) releaseCancellation();
  holdCancellation = false;
  for (const path of [...held.keys()]) releaseMetadata(path);
  metadata.clear();
  holdPaths.clear();
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
const convertFixtureFileSrc: typeof convertFileSrc = () => 'data:,';
if (
  !('__TAURI_INTERNALS__' in window) ||
  typeof window.__TAURI_INTERNALS__ !== 'object' ||
  window.__TAURI_INTERNALS__ === null
)
  throw new Error('Tauri mock internals unavailable');
Object.assign(window.__TAURI_INTERNALS__, { convertFileSrc: convertFixtureFileSrc });
mockIPC(
  (cmd, args) => {
    record('hostMock', { cmd, args });
    switch (cmd) {
      case 'save_metadata_and_update_thumbnail':
      case 'save_settings':
      case 'clear_session_caches':
      case 'precompute_ai_subject_mask':
        return null;
      case 'cancel_ai_task':
        if (!holdCancellation) return null;
        if (cancellationResult) throw new Error('Unexpected concurrent fixture cancel IPC');
        return new Promise<null>((resolve) => {
          cancellationResult = () => resolve(null);
        });
      case 'generate_ai_subject_mask':
        if (generationResult) throw new Error('Unexpected concurrent fixture model request');
        return new Promise<Record<string, unknown>>((resolve) => {
          generationResult = () => resolve({ fixtureResult: 'deferred mock mask parameters' });
        });
      case 'generate_manual_cleanup_patch':
        if (generationResult) throw new Error('Unexpected concurrent fixture patch request');
        return new Promise<string>((resolve) => {
          generationResult = () => resolve(JSON.stringify({ fixturePatch: 'deferred mock patch result' }));
        });
      case 'is_image_cached':
        return true;
      case 'load_image':
        return { width: 3000, height: 2000, is_raw: false, exif: {}, metadata: null };
      case 'load_metadata': {
        const path = args && typeof args === 'object' && 'path' in args ? args.path : undefined;
        if (typeof path !== 'string' || !metadata.has(path)) throw new Error('Unconfigured mock metadata path');
        if (holdPaths.has(path)) return new Promise<{ adjustments: Adjustments }>((resolve) => held.set(path, resolve));
        return { adjustments: structuredClone(metadata.get(path)) };
      }
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
  'compositionstart',
  'compositionend',
]) {
  window.addEventListener(
    type,
    (event) => {
      const target = event.target;
      const element = target instanceof Element ? target : null;
      record('input', {
        type,
        trusted: event.isTrusted,
        target: element?.tagName,
        tag: element?.tagName,
        id: element?.id,
        action: element?.closest('[data-tool-session-action]')?.getAttribute('data-tool-session-action'),
        key: event instanceof KeyboardEvent ? event.key : undefined,
        code: event instanceof KeyboardEvent ? event.code : undefined,
        composing: event instanceof KeyboardEvent ? event.isComposing : undefined,
        x: event instanceof MouseEvent ? event.clientX : undefined,
        y: event instanceof MouseEvent ? event.clientY : undefined,
        value: target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target.value : undefined,
      });
    },
    true,
  );
}
window.addEventListener('error', (event) => record('windowError', { message: event.message }));
window.addEventListener('unhandledrejection', (event) => record('rejection', { message: String(event.reason) }));
