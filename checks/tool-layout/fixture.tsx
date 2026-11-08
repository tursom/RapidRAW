import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import type { DragEndEvent, DragStartEvent } from '@dnd-kit/core';
import type { Platform } from '@tauri-apps/plugin-os';
import en from '../../src/i18n/locales/en.json';
import { ContextMenuProvider } from '../../src/context/ContextMenuContext';
import CurvesPanel from '../../src/components/panel/right/CurvesPanel';
import Controls from '../../src/components/panel/right/ControlsPanel';
import SpeedEditOverlay from '../../src/components/panel/editor/overlays/SpeedEditOverlay';
import Task3SpeedEdit from 'virtual:task3-speed-edit';
import Slider, { getSpeedEditTarget } from '../../src/components/ui/Slider';
import SidePanelArea from '../../src/components/panel/SidePanelArea';
import { MobilePanelSwitcher } from '../../src/components/panel/PanelSwitcher';
import { useUIStore, reconcileWorkspace, isStandaloneCurvesVisible } from '../../src/store/useUIStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useProcessStore } from '../../src/store/useProcessStore';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { debouncedSave, debouncedSetHistory } from '../../src/hooks/useEditorActions';
import { Panel, Theme } from '../../src/components/ui/AppProperties';
import type { AppSettings, PanelRegion, SelectedImage } from '../../src/components/ui/AppProperties';
import { INITIAL_ADJUSTMENTS, INITIAL_MASK_CONTAINER } from '../../src/utils/adjustments';
import { isHistoryMode } from '../../src/utils/appMode';
import * as task3 from 'virtual:task3-ui';
import * as canvasSelectors from 'virtual:canvas-selectors';
import * as maskVisibility from 'virtual:mask-visibility';
import { mark, record, trace } from './host';
import './fixture.css';

await i18n
  .use(initReactI18next)
  .init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
const { THEMES } = await import('../../src/utils/themes');
for (const [key, value] of Object.entries(THEMES.find((entry) => entry.id === Theme.Dark)!.cssVariables))
  document.documentElement.style.setProperty(key, String(value));
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const initialUI = useUIStore.getState();
const initialEditor = useEditorStore.getState();
const initialProcess = useProcessStore.getState();
type UIState = ReturnType<typeof useUIStore.getState>;
type EditorState = ReturnType<typeof useEditorStore.getState>;
type Workspace = Parameters<typeof reconcileWorkspace>[0];
interface ConfigureOptions {
  platform?: Platform;
  noImage?: boolean;
  full?: boolean;
  legacySpeedEdit?: boolean;
}
const FIXTURE_LABELS = {
  placeholder: ' — fixture tool content placeholder (not the production tool)',
  focus: 'Focusable fixture tool boundary',
  canvas: 'Fixture canvas boundary — no image canvas mounted',
  localSlider: 'Fixture local slider sentinel',
};
const image = {
  path: 'C:/fixture/image.jpg',
  width: 3000,
  height: 2000,
  exif: {},
  isRaw: false,
  isReady: true,
  thumbnailUrl: '',
} satisfies SelectedImage;
const settings: AppSettings = { lastRootPath: null, theme: Theme.Dark, editInApps: [] };
let legacySpeedEdit = false;
function snapshot() {
  const ui = useUIStore.getState();
  const editor = useEditorStore.getState();
  return clone({
    activePanel: ui.activePanel,
    renderedPanel: ui.renderedPanel,
    panelModal: ui.panelModal,
    activePanels: ui.activePanels,
    panelLayout: ui.panelLayout,
    panelSwitcherPlacement: ui.panelSwitcherPlacement,
    activeLayoutDragItem: ui.activeLayoutDragItem,
    isFullLayout: ui.isFullLayout,
    uiVisibility: ui.uiVisibility,
    leftPanelWidth: ui.leftPanelWidth,
    rightPanelWidth: ui.rightPanelWidth,
    leftTopHeight: ui.leftTopHeight,
    standalone: isStandaloneCurvesVisible(ui),
    selectedImage: editor.selectedImage,
    adjustments: editor.adjustments,
    activeMaskContainerId: editor.activeMaskContainerId,
    isSliderDragging: editor.isSliderDragging,
    cropSessionSnapshot: editor.cropSessionSnapshot,
    isSpeedEditActive: editor.isSpeedEditActive,
    speedEditTarget: editor.speedEditTarget?.current
      ? {
          label: editor.speedEditTarget.current.label,
          value: editor.speedEditTarget.current.value,
          owner: [...document.querySelectorAll('[data-speed-edit-id]')]
            .find((element) => getSpeedEditTarget(element) === editor.speedEditTarget)
            ?.closest('[data-panel]')
            ?.getAttribute('data-panel'),
        }
      : null,
  });
}
useUIStore.subscribe(() => record('uiStore', snapshot()));
useEditorStore.subscribe(() => record('editorStore', snapshot()));
function cleanup() {
  debouncedSave.cancel();
  debouncedSetHistory.cancel();
}
function configure(options: ConfigureOptions = {}) {
  cleanup();
  legacySpeedEdit = options.legacySpeedEdit ?? false;
  const platform = options.platform ?? 'windows';
  window.__TAURI_OS_PLUGIN_INTERNALS__.platform = platform;
  useSettingsStore.setState({ osPlatform: platform, theme: Theme.Dark, appSettings: clone(settings) });
  const adjustments = clone(INITIAL_ADJUSTMENTS);
  const mask = clone(INITIAL_MASK_CONTAINER);
  mask.id = 'fixture-mask';
  mask.name = 'Fixture mask';
  mask.adjustments.exposure = 17;
  mask.adjustments.contrast = 29;
  mask.adjustments.curves.luma = [
    { x: 0, y: 10 },
    { x: 255, y: 230 },
  ];
  adjustments.masks = [mask];
  useEditorStore.setState({
    ...initialEditor,
    selectedImage: options.noImage ? null : clone(image),
    adjustments,
    history: [clone(adjustments)],
    historyLabels: ['fixture setup'],
    historyIndex: 0,
    activeMaskContainerId: null,
  });
  useProcessStore.setState(initialProcess);
  useLibraryStore.setState({ multiSelectedPaths: [], imageList: [], rootPaths: [] });
  flushSync(() =>
    useUIStore.setState({
      ...initialUI,
      ...reconcileWorkspace(undefined, true, platform, options.full !== false),
      activeView: 'editor',
      isFullLayout: options.full !== false,
      isInstantTransition: true,
      isLayoutReady: true,
      activePanel: Panel.Adjustments,
      renderedPanel: Panel.Adjustments,
      panelModal: null,
      uiVisibility: { leftPanel: true, rightPanel: true, filmstrip: false },
    }),
  );
  record('setup', { options, state: snapshot() });
}
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
function Harness() {
  const ui = useUIStore();
  const adjustments = useEditorStore((state) => state.adjustments);
  useKeyboardShortcuts(shortcutProps);
  const renderPanel = (panel: Panel) => {
    if (panel === Panel.Curves) return <CurvesPanel />;
    if (panel === Panel.Adjustments) return <Controls />;
    return (
      <div data-tool-placeholder={panel} className="p-3">
        <p>
          {panel}
          {FIXTURE_LABELS.placeholder}
        </p>
        <button>{FIXTURE_LABELS.focus}</button>
        {([Panel.Crop, Panel.Masks, Panel.Ai] as Panel[]).includes(panel) &&
          ['exposure', 'contrast', 'highlights'].map((id) => (
            <Slider
              key={id}
              label={FIXTURE_LABELS.localSlider}
              speedEditId={id}
              value={adjustments.masks[0].adjustments[id as 'exposure' | 'contrast' | 'highlights']}
              min={-100}
              max={100}
              step={1}
              onChange={(event) => {
                const next = clone(useEditorStore.getState().adjustments);
                next.masks[0].adjustments[id as 'exposure' | 'contrast' | 'highlights'] = Number(event.target.value);
                useEditorStore.getState().setEditor({ adjustments: next });
              }}
            />
          ))}
      </div>
    );
  };
  return (
    <main className="flex h-full min-h-0 bg-bg-primary text-text-primary p-2 gap-1">
      {ui.isFullLayout && ui.uiVisibility.leftPanel && (
        <aside id="left" className="h-full min-h-0">
          <SidePanelArea
            side="left"
            width={ui.leftPanelWidth}
            topRegion="leftTop"
            bottomRegion="leftBottom"
            renderPanel={renderPanel}
            onWidthChange={() => {}}
            onWidthReset={() => {}}
            isResizing={false}
          />
        </aside>
      )}
      <div id="canvas-boundary" tabIndex={0} className="relative flex-1 min-w-0">
        {FIXTURE_LABELS.canvas}
        {legacySpeedEdit ? <Task3SpeedEdit /> : <SpeedEditOverlay />}
      </div>
      {ui.isFullLayout ? (
        <aside id="right" className="h-full min-h-0">
          <SidePanelArea
            side="right"
            width={ui.rightPanelWidth}
            topRegion="rightTop"
            bottomRegion="rightBottom"
            renderPanel={renderPanel}
            onWidthChange={() => {}}
            onWidthReset={() => {}}
            isResizing={false}
          />
        </aside>
      ) : (
        <aside id="compact" className="flex h-full w-[340px] min-h-0 flex-col">
          <div className="flex-1 min-h-0 overflow-auto">{ui.activePanel && renderPanel(ui.activePanel)}</div>
          <div id="mobile-switcher">
            <MobilePanelSwitcher activePanel={ui.activePanel} onPanelSelect={ui.setPanel} />
          </div>
        </aside>
      )}
    </main>
  );
}
function Providers() {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  const start = (event: DragStartEvent) => {
    record('dndStart', { id: event.active.id });
    // Mirrors the App layout-tab handler boundary, not an alternative drag implementation.
    if (event.active.data.current?.type === 'layout-tab')
      useUIStore.getState().setLayoutDragItem(event.active.data.current.panel);
  };
  const end = (event: DragEndEvent) => {
    record('dndEnd', { id: event.active.id, over: event.over?.id });
    if (event.active.data.current?.type === 'layout-tab' && event.over?.data.current?.type === 'layout-region')
      useUIStore.getState().movePanel(event.active.data.current.panel, event.over.data.current.region);
    useUIStore.getState().setLayoutDragItem(null);
  };
  return (
    <DndContext sensors={sensors} onDragStart={start} onDragEnd={end}>
      <ContextMenuProvider>
        <Harness />
      </ContextMenuProvider>
    </DndContext>
  );
}
configure();
createRoot(document.getElementById('root')!).render(<Providers />);
const api = {
  configure,
  snapshot,
  cleanup,
  mark,
  trace: () => clone(trace),
  patchUI(update: Parameters<UIState['setUI']>[0]) {
    flushSync(() => useUIStore.getState().setUI(update));
  },
  singletonRegionSetup() {
    // Isolated component setup: bypass fixed-workspace reconciliation to exercise singleton rendering.
    flushSync(() =>
      useUIStore.setState((state) => ({
        panelLayout: { ...state.panelLayout, leftTop: [Panel.Curves, Panel.Metadata, Panel.Export] },
      })),
    );
  },
  patchEditor(update: Parameters<EditorState['setEditor']>[0]) {
    flushSync(() => useEditorStore.getState().setEditor(update));
  },
  setPanel(panel: Panel) {
    flushSync(() => useUIStore.getState().setPanel(panel));
  },
  setActivePanel(region: PanelRegion, panel: Panel) {
    flushSync(() => useUIStore.getState().setActivePanel(region, panel));
  },
  workspace(saved: Workspace | null, platform: Platform = 'windows', full = true) {
    return reconcileWorkspace(saved ?? undefined, true, platform, full);
  },
  task3Workspace(saved: Workspace | null, platform: Platform = 'windows', full = true) {
    return task3.reconcileWorkspace(saved ?? undefined, true, platform, full);
  },
  task3Content(mode: Panel) {
    task3.useUIStore.setState({ activePanel: mode });
    task3.useUIStore.getState().setActivePanel('rightTop', Panel.Adjustments);
    return { activePanel: task3.useUIStore.getState().activePanel };
  },
  attemptLayoutMutation() {
    const ui = useUIStore.getState();
    ui.setLayoutDragItem(Panel.Crop);
    ui.movePanel(Panel.Crop, 'rightTop');
    ui.movePanelToIndex(Panel.Ai, 'leftTop', 0);
    ui.setPanelSwitcherPlacement('leftBottom', 'left');
  },
  selectors(base = false) {
    return (base ? canvasSelectors.task3 : canvasSelectors.current)(useUIStore.getState());
  },
  maskVisibility(base = false) {
    return (base ? maskVisibility.task3 : maskVisibility.current)(useUIStore.getState());
  },
  isHistoryMode,
};
declare global {
  interface Window {
    toolLayoutFixture: typeof api;
  }
}
window.toolLayoutFixture = api;
