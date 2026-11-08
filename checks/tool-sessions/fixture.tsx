import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { AnimatePresence } from 'framer-motion';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import type { Platform } from '@tauri-apps/plugin-os';
import en from '../../src/i18n/locales/en.json';
import { ContextMenuProvider } from '../../src/context/ContextMenuContext';
import ToolSessionActions from '../../src/components/panel/editor/ToolSessionActions';
import SidePanelArea from '../../src/components/panel/SidePanelArea';
import CurvesPanel from '../../src/components/panel/right/CurvesPanel';
import Slider from '../../src/components/ui/Slider';
import { Panel, Theme } from '../../src/components/ui/AppProperties';
import type { SelectedImage } from '../../src/components/ui/AppProperties';
import { useUIStore, reconcileWorkspace } from '../../src/store/useUIStore';
import { useEditorStore } from '../../src/store/useEditorStore';
import type { ToolSessionPanel } from '../../src/store/useEditorStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useProcessStore } from '../../src/store/useProcessStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { useKeyboardShortcuts as useTask4Keyboard } from 'virtual:task4-keyboard';
import {
  cancelCrop as task4CancelCrop,
  debouncedSetHistory as task4DebouncedHistory,
  debouncedSave as task4DebouncedSave,
} from 'virtual:task4-actions';
import {
  useEditorActions,
  applyToolSession,
  cancelToolSession,
  isToolSessionBusy,
  debouncedSave,
  debouncedSetHistory,
} from '../../src/hooks/useEditorActions';
import { useAppNavigation } from '../../src/hooks/useAppNavigation';
import type { AppNavigationProps } from '../../src/hooks/useAppNavigation';
import { useImageLoader } from '../../src/hooks/useImageLoader';
import { useAiMasking } from '../../src/hooks/useAiMasking';
import { Mask, SubMaskMode } from '../../src/components/panel/right/Masks';
import { globalImageCache } from '../../src/utils/ImageLRUCache';
import { INITIAL_ADJUSTMENTS, INITIAL_MASK_CONTAINER } from '../../src/utils/adjustments';
import type { Adjustments } from '../../src/utils/adjustments';
import {
  mark,
  record,
  trace,
  prepareMetadata,
  releaseMetadata,
  releaseGeneration,
  deferCancellation,
  releaseCancellation,
  resetHost,
} from './host';
import './fixture.css';

await i18n.use(initReactI18next).init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});
const { THEMES } = await import('../../src/utils/themes');
for (const [key, value] of Object.entries(THEMES.find((theme) => theme.id === Theme.Dark)!.cssVariables))
  document.documentElement.style.setProperty(key, String(value));
const clone = <T,>(value: T): T => structuredClone(value);
const initialUI = useUIStore.getState();
const initialEditor = useEditorStore.getState();
const initialProcess = useProcessStore.getState();
const tools: ToolSessionPanel[] = [Panel.Crop, Panel.Masks, Panel.Ai];
type EditorState = ReturnType<typeof useEditorStore.getState>;
type CacheEntry = Parameters<typeof globalImageCache.set>[1];
type NavigationMode = 'cached' | 'cold';
const paths = { a: 'C:/fixture/A.jpg', b: 'C:/fixture/B.jpg' };
const LABELS = {
  tools: 'Fixture mode entry — production store routing',
  edit: 'Fixture tool mutation — no brush, crop canvas or model',
  canvas: 'Canvas boundary placeholder — no ImageCanvas or rendered photo',
  contrast: 'Fixture global contrast',
  prompt: 'Fixture AI prompt input',
  rename: 'Fixture mask rename input',
  editable: 'Fixture editable input',
  cached: 'Fixture navigate B cached',
  cold: 'Fixture navigate B cold',
  undo: 'Fixture production Undo',
  redo: 'Fixture production Redo',
  generate: 'Fixture invoke real AI hook with deferred mock result',
  patch: 'Fixture invoke real patch hook with deferred mock result',
  returnA: 'Fixture navigate back to cached A',
  cancelTask: 'Fixture invoke existing AI cancel hook with mock IPC',
  lifecycle: 'Explicit tool content placeholder — real SidePanelArea and PanelSwitcher lifecycle',
  paintToolbar: 'Explicit toolbar placeholder — production Editor stacking classes',
  paintViewport: 'Explicit viewport placeholder — no Editor, ImageCanvas or WGPU renderer',
};
const PANEL_TITLES: Partial<Record<Panel, string>> = {
  [Panel.Presets]: 'Presets',
  [Panel.Crop]: 'Crop',
  [Panel.Masks]: 'Masks',
  [Panel.Ai]: 'AI',
};
function image(path: string, ready = true): SelectedImage {
  return { path, width: 3000, height: 2000, exif: {}, isRaw: false, isReady: ready, thumbnailUrl: '' };
}
function seed(rank: number): Adjustments {
  const adjustments = clone(INITIAL_ADJUSTMENTS);
  adjustments.rotation = rank;
  adjustments.contrast = rank;
  const mask = clone(INITIAL_MASK_CONTAINER);
  mask.id = `mask-${rank}`;
  mask.name = `Sentinel mask ${rank}`;
  mask.adjustments.exposure = rank + 9;
  mask.subMasks = [
    {
      id: 'mask-submask',
      invert: false,
      mode: SubMaskMode.Additive,
      opacity: 100,
      type: Mask.Brush,
      visible: true,
      parameters: { fixtureOwner: rank },
    },
  ];
  adjustments.masks = [mask];
  adjustments.aiPatches = [
    {
      id: `ai-${rank}`,
      isLoading: false,
      invert: false,
      name: `Patch ${rank}`,
      patchData: null,
      prompt: `Mock seed ${rank}`,
      subMasks: [
        {
          id: 'ai-submask',
          invert: false,
          mode: SubMaskMode.Additive,
          opacity: 100,
          type: Mask.Brush,
          visible: true,
          parameters: { fixtureOwner: rank },
        },
      ],
      visible: true,
    },
  ];
  return adjustments;
}
const cachedEditStateRef: React.RefObject<CacheEntry | null> = { current: null };
const navigationRefs = {
  cachedEditStateRef,
  transformWrapperRef: { current: null },
  preloadedDataRef: { current: null },
  selectedImagePathRef: { current: paths.a as string | null },
  isBackendReadyRef: { current: true },
  latestRenderedJobIdRef: { current: 0 },
  previewJobIdRef: { current: 0 },
  currentResRef: { current: 0 },
  prevAdjustmentsRef: { current: null },
} satisfies AppNavigationProps['refs'];
let legacyKeyboard = false;
let realSidePanel = false;
interface EditorPaintLayout {
  outerClass: string;
  toolbarClass: string;
  viewportClass: string;
}
let editorPaintLayout: EditorPaintLayout | null = null;
let productionPaintActionsClass: string | null = null;
let lifecycleInstance = 0;
const lifecycleEvents: { type: string; panel: Panel; instance: number; at: number }[] = [];
let pendingHook: Promise<void> | null = null;
const root = createRoot(document.getElementById('root')!);
function snapshot() {
  const editor = useEditorStore.getState();
  const ui = useUIStore.getState();
  return clone({
    activePanel: ui.activePanel,
    activePanels: ui.activePanels,
    selectedImage: editor.selectedImage,
    adjustments: editor.adjustments,
    history: editor.history,
    historyIndex: editor.historyIndex,
    historyPath: editor.historyPath,
    historyRevision: editor.historyRevision,
    toolSessionPanel: editor.toolSessionPanel,
    cropSessionSnapshot: editor.cropSessionSnapshot,
    masksSessionSnapshot: editor.masksSessionSnapshot,
    aiSessionSnapshot: editor.aiSessionSnapshot,
    activeMaskContainerId: editor.activeMaskContainerId,
    activeMaskId: editor.activeMaskId,
    activeAiPatchContainerId: editor.activeAiPatchContainerId,
    activeAiSubMaskId: editor.activeAiSubMaskId,
    isStraightenActive: editor.isStraightenActive,
    isGeneratingAi: editor.isGeneratingAi,
    isGeneratingAiMask: editor.isGeneratingAiMask,
    activeAiTasks: useProcessStore.getState().activeAiTasks,
    busy: isToolSessionBusy(),
  });
}
useUIStore.subscribe(() => record('uiStore', { state: snapshot() }));
useEditorStore.subscribe(() => record('editorStore', { state: snapshot() }));
useProcessStore.subscribe(() => record('processStore', { state: snapshot() }));
function cleanup() {
  debouncedSave.cancel();
  debouncedSetHistory.cancel();
  task4DebouncedHistory.cancel();
  task4DebouncedSave.cancel();
  resetHost();
  globalImageCache.clear();
}
async function settleCleanup() {
  cleanup();
  await pendingHook;
  await new Promise((resolve) => setTimeout(resolve, 0));
  cleanup();
  return { debouncesCancelled: true, mockRequestsReleased: true };
}
interface ConfigureOptions {
  platform?: Platform;
  noImage?: boolean;
  full?: boolean;
  legacyKeyboard?: boolean;
  realSidePanel?: boolean;
  editorPaintLayout?: EditorPaintLayout;
}
function configure(options: ConfigureOptions = {}) {
  cleanup();
  legacyKeyboard = options.legacyKeyboard ?? false;
  realSidePanel = options.realSidePanel ?? false;
  editorPaintLayout = options.editorPaintLayout ?? null;
  productionPaintActionsClass = null;
  const platform = options.platform ?? 'windows';
  window.__TAURI_OS_PLUGIN_INTERNALS__.platform = platform;
  useSettingsStore.setState({
    osPlatform: platform,
    theme: Theme.Dark,
    appSettings: { lastRootPath: null, theme: Theme.Dark, editInApps: [], useWgpuRenderer: !!editorPaintLayout },
  });
  flushSync(() => {
    useUIStore.setState({ ...initialUI, activePanel: Panel.Adjustments });
    useEditorStore.setState({
      ...initialEditor,
      selectedImage: options.noImage ? null : image(paths.a),
      finalPreviewUrl: 'data:,',
    });
    useEditorStore.getState().resetHistory(seed(1));
    useProcessStore.setState(initialProcess);
    useLibraryStore.setState({ multiSelectedPaths: [], imageList: [], rootPaths: [], isViewLoading: false });
    useUIStore.setState({
      ...initialUI,
      ...reconcileWorkspace(undefined, true, platform, options.full !== false),
      activeView: 'editor',
      activePanel: Panel.Adjustments,
      renderedPanel: Panel.Adjustments,
      isFullLayout: options.full !== false,
      isInstantTransition: !realSidePanel,
      isLayoutReady: true,
      ...(realSidePanel
        ? {
            leftPanelWidth: 300,
            leftTopHeight: 340,
            uiVisibility: { leftPanel: true, rightPanel: true, filmstrip: false },
          }
        : {}),
    });
    cachedEditStateRef.current = null;
    root.render(
      <ContextMenuProvider>
        <Harness key={++generation} />
      </ContextMenuProvider>,
    );
  });
  record('programmaticSetup', { options, state: snapshot() });
}
let generation = 0;
const external =
  (name: string) =>
  (...args: unknown[]) =>
    record('externalCallback', { name, args });
const shortcutProps: Parameters<typeof useKeyboardShortcuts>[0] = {
  sortedImageList: [],
  handleBackToLibrary: external('back'),
  handleDeleteSelected: external('delete'),
  handleDeleteRejected: external('deleteRejected'),
  handleGoHome: external('home'),
  handleImageSelect: external('imageSelect'),
  handlePasteFiles: external('pasteFiles'),
  handleZoomChange: external('zoom'),
};
function CurrentKeyboard() {
  useKeyboardShortcuts(shortcutProps);
  return null;
}
function LegacyKeyboard() {
  useTask4Keyboard(shortcutProps);
  return null;
}
function mutateTool(prev: Adjustments, panel: Panel | null): Adjustments {
  if (panel === Panel.Crop) return { ...prev, rotation: prev.rotation + 12, flipHorizontal: !prev.flipHorizontal };
  if (panel === Panel.Masks)
    return { ...prev, masks: prev.masks.map((mask) => ({ ...mask, name: `${mask.name} edited`, opacity: 37 })) };
  if (panel === Panel.Ai)
    return {
      ...prev,
      aiPatches: prev.aiPatches.map((patch) => ({ ...patch, prompt: `${patch.prompt} edited`, invert: !patch.invert })),
    };
  throw new Error('Fixture mutation requires active tool');
}
function prepareNavigation(mode: NavigationMode) {
  const baseline = seed(21);
  const fresh = seed(31);
  globalImageCache.delete(paths.b);
  if (mode === 'cached') {
    globalImageCache.set(paths.b, {
      selectedImage: image(paths.b),
      adjustments: baseline,
      histogram: null,
      waveform: null,
      finalPreviewUrl: null,
      uncroppedPreviewUrl: null,
      originalSize: { width: 3000, height: 2000 },
      previewSize: { width: 0, height: 0 },
    });
  }
  prepareMetadata(paths.b, fresh, true);
  record('programmaticSetup', { navigation: mode, cached: baseline, fresh });
}
function Harness() {
  const panel = useUIStore((state) => state.activePanel);
  const adjustments = useEditorStore((state) => state.adjustments);
  const { setAdjustments } = useEditorActions();
  const { handleGenerateAiMask, handleDirectPatch, handleCancelAiTask } = useAiMasking();
  const navigation = useAppNavigation({ clearThumbnailQueue: external('clearThumbnails'), refs: navigationRefs });
  useImageLoader(cachedEditStateRef);
  if (realSidePanel) return <LifecycleHarness />;
  if (editorPaintLayout) return <EditorPaintHarness layout={editorPaintLayout} />;
  return (
    <main id="workspace">
      {legacyKeyboard ? <LegacyKeyboard /> : <CurrentKeyboard />}
      <aside id="tools">
        <p>{LABELS.tools}</p>
        <div className="fixture-controls">
          {[...tools, Panel.Presets].map((tool) => (
            <button key={tool} data-mode={tool} onClick={() => useUIStore.getState().setPanel(tool)}>
              {tool}
            </button>
          ))}
        </div>
        <button id="mutate-tool" onClick={() => setAdjustments((prev) => mutateTool(prev, panel))}>
          {LABELS.edit}
        </button>
        <button
          id="generate-hook"
          onClick={() =>
            void (pendingHook = handleGenerateAiMask(
              panel === Panel.Ai ? 'ai-submask' : 'mask-submask',
              { x: 0.1, y: 0.1 },
              { x: 0.8, y: 0.8 },
            ))
          }
        >
          {LABELS.generate}
        </button>
        <button id="patch-hook" onClick={() => void (pendingHook = handleDirectPatch('ai-submask'))}>
          {LABELS.patch}
        </button>
        <button id="cancel-task-hook" onClick={() => void (pendingHook = handleCancelAiTask('legacy-orphan-patch'))}>
          {LABELS.cancelTask}
        </button>
        <textarea id="prompt" aria-label={LABELS.prompt} />
        <input id="rename" aria-label={LABELS.rename} />
        <div id="editable" contentEditable suppressContentEditableWarning aria-label={LABELS.editable} />
        <div className="fixture-controls">
          <button id="navigate-cached" onClick={() => void navigation.handleImageSelect(paths.b)}>
            {LABELS.cached}
          </button>
          <button id="navigate-cold" onClick={() => void navigation.handleImageSelect(paths.b)}>
            {LABELS.cold}
          </button>
          <button id="navigate-a" onClick={() => void navigation.handleImageSelect(paths.a)}>
            {LABELS.returnA}
          </button>
          <button id="undo" onClick={() => useEditorStore.getState().undo()}>
            {LABELS.undo}
          </button>
          <button id="redo" onClick={() => useEditorStore.getState().redo()}>
            {LABELS.redo}
          </button>
        </div>
      </aside>
      <div id="focused-editor">
        <div id="canvas-boundary" tabIndex={0}>
          {LABELS.canvas}
        </div>
        <ToolSessionActions />
      </div>
      <aside id="adjustments">
        <Slider
          label={LABELS.contrast}
          value={adjustments.contrast}
          min={-100}
          max={100}
          step={1}
          onChange={(event) => setAdjustments({ contrast: Number(event.target.value) })}
        />
        <CurvesPanel />
      </aside>
    </main>
  );
}
function EditorPaintHarness({ layout }: { layout: EditorPaintLayout }) {
  return (
    <div style={{ position: 'absolute', left: 300, top: 8, width: 658, height: 504, display: 'flex' }}>
      <div id="paint-editor-layout" className={layout.outerClass}>
        <div id="paint-toolbar" className={layout.toolbarClass} style={{ height: 40 }}>
          {LABELS.paintToolbar}
        </div>
        <div id="paint-viewport" className={layout.viewportClass}>
          <div style={{ margin: 'auto', padding: 12, border: '1px solid #888' }}>{LABELS.paintViewport}</div>
        </div>
        <ToolSessionActions />
      </div>
    </div>
  );
}
function paintSnapshot() {
  // Resolve the semantic variable through the browser, and independently prove
  // the generated utility supplies it rather than inheriting the body's color.
  const probe = document.createElement('span');
  probe.style.cssText = 'position:fixed;left:-10000px;color:transparent;visibility:hidden;pointer-events:none';
  const token = document.createElement('span');
  token.style.color = 'var(--color-text-primary)';
  const utility = document.createElement('span');
  utility.className = 'text-text-primary';
  probe.append(token, utility);
  document.body.append(probe);
  const semanticColors = {
    theme: useSettingsStore.getState().theme,
    tokenProperty: '--color-text-primary',
    tokenDeclaration: getComputedStyle(token).getPropertyValue('--color-text-primary').trim(),
    appTokenProperty: '--app-text-primary',
    appTokenDeclaration: getComputedStyle(token).getPropertyValue('--app-text-primary').trim(),
    resolvedTokenColor: getComputedStyle(token).color,
    generatedUtilityClass: utility.className,
    generatedUtilityColor: getComputedStyle(utility).color,
    probeParentColor: getComputedStyle(probe).color,
  };
  probe.remove();
  const describe = (element: Element | null) => {
    if (!(element instanceof HTMLElement)) throw new Error('Missing paint fixture element');
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      tag: element.tagName,
      text: element.textContent,
      className: element.className,
      rect: rect.toJSON(),
      connected: element.isConnected,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
      position: style.position,
      zIndex: style.zIndex,
      isolation: style.isolation,
      boxShadow: style.boxShadow,
      backgroundColor: style.backgroundColor,
      color: style.color,
      hit:
        document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.closest('button') ===
        element,
    };
  };
  return {
    actions: describe(document.querySelector('[data-tool-session-actions]')),
    viewport: describe(document.querySelector('#paint-viewport')),
    toolbar: describe(document.querySelector('#paint-toolbar')),
    buttons: [...document.querySelectorAll('[data-tool-session-action]')].map(describe),
    productionActionsClass: productionPaintActionsClass,
    semanticColors,
    applicationCanvasMounted: !!document.querySelector('canvas'),
  };
}
function LifecycleContent({ panel }: { panel: Panel }) {
  const [instance] = React.useState(() => ++lifecycleInstance);
  React.useLayoutEffect(() => {
    const emit = (type: string) => {
      const event = { type, panel, instance, at: performance.now() };
      lifecycleEvents.push(event);
      record('panelLifecycle', event);
    };
    emit('mount');
    return () => emit('unmount');
  }, [panel, instance]);
  return (
    <section data-lifecycle-panel={panel} data-lifecycle-instance={instance}>
      <h2 data-lifecycle-heading={panel}>{PANEL_TITLES[panel] ?? panel}</h2>
      <p>{LABELS.lifecycle}</p>
    </section>
  );
}
function LifecycleHarness() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  return (
    <DndContext sensors={sensors}>
      <main id="lifecycle-workspace" style={{ display: 'flex', height: '100vh', gap: 8, padding: 8 }}>
        <CurrentKeyboard />
        <aside style={{ width: 300, flexShrink: 0 }}>
          <SidePanelArea
            side="left"
            width={300}
            topRegion="leftTop"
            bottomRegion="leftBottom"
            renderPanel={(panel) => <LifecycleContent panel={panel} />}
            onWidthChange={external('lifecycleWidthChange')}
            onWidthReset={external('lifecycleWidthReset')}
            isResizing={false}
          />
        </aside>
        <div id="focused-editor" style={{ flex: 1 }}>
          <div id="canvas-boundary" tabIndex={0}>
            {LABELS.canvas}
          </div>
          <ToolSessionActions />
        </div>
      </main>
    </DndContext>
  );
}
// Read only the current root, rather than stale alternate pointers on a DOM node.
// This is observation of the actual production AnimatePresence and motion keys.
interface ObservedFiber {
  type: unknown;
  key: string | null;
  stateNode: unknown;
  child: ObservedFiber | null;
  sibling: ObservedFiber | null;
  memoizedProps: { children?: { key?: string | null } } | null;
}
function lifecycleSnapshot() {
  const region = document.querySelector('[data-panel-region="leftBottom"]');
  const current = (root as unknown as { _internalRoot: { current: ObservedFiber } })._internalRoot.current;
  const find = (node: ObservedFiber | null, predicate: (fiber: ObservedFiber) => boolean): ObservedFiber | null => {
    for (let fiber = node; fiber; fiber = fiber.sibling) {
      if (predicate(fiber)) return fiber;
      const child = find(fiber.child, predicate);
      if (child) return child;
    }
    return null;
  };
  const regionFiber = find(current, (fiber) => fiber.stateNode === region);
  const presence = find(regionFiber?.child ?? null, (fiber) => fiber.type === AnimatePresence);
  const ui = useUIStore.getState();
  return {
    at: performance.now(),
    activePanel: ui.activePanel,
    renderedPanel: ui.renderedPanel,
    regionalPanel: ui.activePanels.leftBottom,
    outerPanel: region?.getAttribute('data-panel'),
    presenceKey: presence?.key,
    currentPaneKey: presence?.memoizedProps?.children?.key,
    headings: [...(region?.querySelectorAll<HTMLElement>('[data-lifecycle-heading]') ?? [])].map((heading) => {
      const rect = heading.getBoundingClientRect();
      let opacity = 1;
      let hidden = false;
      for (let node: Element | null = heading; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        opacity *= Number(style.opacity);
        hidden ||= style.display === 'none' || style.visibility === 'hidden';
      }
      return {
        panel: heading.dataset.lifecycleHeading,
        title: heading.textContent,
        instance: Number(heading.closest<HTMLElement>('[data-lifecycle-instance]')?.dataset.lifecycleInstance),
        connected: heading.isConnected,
        rect: rect.toJSON(),
        opacity,
        hidden,
      };
    }),
    html: region?.outerHTML,
    events: clone(lifecycleEvents),
  };
}
document.addEventListener(
  'click',
  (event) => {
    if (!realSidePanel || !(event.target instanceof Element)) return;
    record('lifecycleClick', {
      at: performance.now(),
      trusted: event.isTrusted,
      action: event.target.closest<HTMLElement>('[data-tool-session-action]')?.dataset.toolSessionAction,
      tab: event.target.closest<HTMLElement>('[data-tab-id]')?.dataset.tabId,
    });
  },
  true,
);
configure();
const api = {
  configure,
  snapshot,
  lifecycleSnapshot,
  paintSnapshot,
  preparePaint(mode: ToolSessionPanel, variant: 'production' | 'old-static-control', theme: Theme = Theme.Dark) {
    if (!editorPaintLayout) throw new Error('Paint fixture must be explicitly configured');
    const definition = THEMES.find((candidate) => candidate.id === theme);
    if (!definition) throw new Error('Unknown production paint theme');
    for (const [key, value] of Object.entries(definition.cssVariables))
      document.documentElement.style.setProperty(key, String(value));
    useSettingsStore.setState({ theme });
    flushSync(() => useUIStore.getState().setPanel(mode));
    const actions = document.querySelector('[data-tool-session-actions]');
    if (!(actions instanceof HTMLElement)) throw new Error('Production actions not mounted');
    productionPaintActionsClass ??= actions.className;
    actions.className =
      variant === 'production' ? productionPaintActionsClass : 'shrink-0 flex justify-center gap-3 py-2';
    record('programmaticSetup', {
      paintMode: mode,
      paintTheme: theme,
      themeOrigin: 'Production THEMES variables; no product colors supplied by the fixture',
      variant,
      productionActionsClass: productionPaintActionsClass,
      effectiveActionsClass: actions.className,
      oldStaticComponentSha256: 'd88d1429e1e34a29aa3e2fd23f1219a54cf8a9e848f108f70972ddf57ea05c4e',
      boundary: 'Only the historical wrapper class is overridden; all buttons, handlers, stores and CSS are production',
    });
  },
  cleanup: settleCleanup,
  mark,
  trace: (offset = 0) => clone(trace.slice(offset)),
  traceLength: () => trace.length,
  paths,
  seed,
  prepareNavigation,
  releaseMetadata: (key: keyof typeof paths = 'b') => releaseMetadata(paths[key]),
  releaseGeneration,
  releaseCancellation,
  prepareLegacyOrphan() {
    const adjustments = seed(81);
    adjustments.aiPatches[0].id = 'legacy-orphan-patch';
    adjustments.aiPatches[0].subMasks[0].id = 'legacy-orphan-submask';
    adjustments.aiPatches[0].isLoading = true;
    flushSync(() => useEditorStore.getState().resetHistory(adjustments));
    deferCancellation();
    record('programmaticSetup', {
      legacyMetadataLoading: true,
      patchId: 'legacy-orphan-patch',
      requestOrigin: 'No generate hook invoked; unique legacy ID; first case after module initialization',
      activeAiTasks: useProcessStore.getState().activeAiTasks,
    });
  },
  waitForGeneration: async () => {
    await pendingHook;
  },
  prepareReturnA: () => prepareMetadata(paths.a, seed(1), true),
  cachedA: () => clone(globalImageCache.get(paths.a)?.adjustments ?? null),
  rebaseSameImage() {
    flushSync(() => useEditorStore.getState().resetHistory(seed(41)));
    record('programmaticSetup', { sameImageMetadataRebase: true });
  },
  rebasePendingImage() {
    const adjustments = clone(useEditorStore.getState().adjustments);
    flushSync(() => useEditorStore.getState().resetHistory(adjustments));
    record('programmaticSetup', { resetHistoryFromLivePendingHookState: true });
  },
  setupEditor(update: Parameters<EditorState['setEditor']>[0]) {
    record('programmaticSetup', { update });
    flushSync(() => useEditorStore.getState().setEditor(update));
  },
  setupLayer(panel: ToolSessionPanel) {
    flushSync(() =>
      useEditorStore
        .getState()
        .setEditor(
          panel === Panel.Masks
            ? { activeMaskContainerId: 'mask-layer', activeMaskId: 'sub-layer' }
            : { activeAiPatchContainerId: 'ai-layer', activeAiSubMaskId: 'sub-layer' },
        ),
    );
    record('programmaticSetup', { layer: panel });
  },
  setupBusy(kind: string, value: boolean) {
    flushSync(() => {
      const editor = useEditorStore.getState();
      if (kind === 'isGeneratingAi' || kind === 'isGeneratingAiMask') editor.setEditor({ [kind]: value });
      else if (kind === 'maskLoading')
        editor.setEditor({
          adjustments: {
            ...editor.adjustments,
            masks: editor.adjustments.masks.map((mask) => ({ ...mask, isLoading: value })),
          },
        });
      else if (kind === 'aiLoading')
        editor.setEditor({
          adjustments: {
            ...editor.adjustments,
            aiPatches: editor.adjustments.aiPatches.map((patch) => ({ ...patch, isLoading: value })),
          },
        });
      else if (kind === 'activeAiTasks')
        useProcessStore.getState().setProcess({
          activeAiTasks: value
            ? { 'unselected-container': { id: 'unselected-container', type: 'fixture-model-task' } }
            : {},
        });
      else throw new Error(`Unknown busy setup: ${kind}`);
    });
    record('programmaticSetup', { busyKind: kind, value });
  },
  preparePending() {
    // Deliberately pending production debounce; this is setup, never counted as browser interaction.
    const editor = useEditorStore.getState();
    const adjustments = mutateTool(editor.adjustments, useUIStore.getState().activePanel);
    editor.setEditor({ adjustments });
    debouncedSetHistory(adjustments);
    record('programmaticSetup', { pendingHistory: true });
  },
  productionAction(name: 'apply' | 'cancel' | 'task4Cancel') {
    flushSync(() =>
      name === 'apply' ? applyToolSession() : name === 'cancel' ? cancelToolSession() : task4CancelCrop(),
    );
  },
};
declare global {
  interface Window {
    toolSessionsFixture: typeof api;
  }
}
window.toolSessionsFixture = api;
