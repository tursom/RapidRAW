import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import en from '../../src/i18n/locales/en.json';
import { ContextMenuProvider } from '../../src/context/ContextMenuContext';
import CurvesPanel from '../../src/components/panel/right/CurvesPanel';
import Controls from '../../src/components/panel/right/ControlsPanel';
import SidePanelArea from '../../src/components/panel/SidePanelArea';
import { MobilePanelSwitcher } from '../../src/components/panel/PanelSwitcher';
import AppPanelModal from '../../src/components/modals/AppPanelModal';
import ExportPanel from '../../src/components/panel/right/ExportPanel';
import MetadataPanel from '../../src/components/panel/right/MetadataPanel';
import SpeedEditOverlay from '../../src/components/panel/editor/overlays/SpeedEditOverlay';
import { useUIStore, reconcileWorkspace, isStandaloneCurvesVisible } from '../../src/store/useUIStore';
import { useSettingsStore } from '../../src/store/useSettingsStore';
import { useEditorStore } from '../../src/store/useEditorStore';
import { useLibraryStore } from '../../src/store/useLibraryStore';
import { useProcessStore } from '../../src/store/useProcessStore';
import { useKeyboardShortcuts } from '../../src/hooks/useKeyboardShortcuts';
import { useAppContextMenus } from '../../src/hooks/useAppContextMenus';
import { debouncedSave, debouncedSetHistory } from '../../src/hooks/useEditorActions';
import { Panel, Theme } from '../../src/components/ui/AppProperties';
import type { AppSettings, ImageFile, PanelRegion, SelectedImage } from '../../src/components/ui/AppProperties';
import type { Platform } from '@tauri-apps/plugin-os';
import { Status } from '../../src/components/ui/ExportImportProperties';
import { INITIAL_ADJUSTMENTS, INITIAL_MASK_CONTAINER, getActiveTools } from '../../src/utils/adjustments';
import { isHistoryMode } from '../../src/utils/appMode';
import * as baseUI from 'virtual:base-ui';
import { mark, record, releaseExport, trace } from './host';
import './fixture.css';

await i18n
  .use(initReactI18next)
  .init({ lng: 'en', resources: { en: { translation: en } }, interpolation: { escapeValue: false } });
// Same theme tokens as production dark theme. Layout, components, utilities come from production CSS.
const { THEMES } = await import('../../src/utils/themes');
const dark = THEMES.find((entry) => entry.id === Theme.Dark)!;
for (const [key, value] of Object.entries(dark.cssVariables))
  document.documentElement.style.setProperty(key, String(value));

const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const initialUI = useUIStore.getState();
const initialEditor = useEditorStore.getState();
const initialProcess = useProcessStore.getState();
type UIState = ReturnType<typeof useUIStore.getState>;
type EditorState = ReturnType<typeof useEditorStore.getState>;
type SavedWorkspace = Parameters<typeof reconcileWorkspace>[0];
interface ConfigureOptions {
  platform?: Platform;
  noImage?: boolean;
  full?: boolean;
}
const FIXTURE_LABELS = {
  toolContentSuffix: ' — fixture content placeholder',
  toolButton: 'Focusable tool placeholder',
  canvas: 'Host-free canvas boundary',
};
const image = {
  path: 'C:/fixture/image.jpg',
  width: 0,
  height: 0,
  exif: {},
  isRaw: false,
  isReady: true,
  thumbnailUrl: '',
} satisfies SelectedImage;
const libraryImage: ImageFile = {
  path: image.path,
  is_edited: false,
  modified: 0,
  rating: 0,
  flag: null,
  tags: [],
  exif: image.exif,
  is_virtual_copy: false,
  is_cloud_placeholder: false,
  is_raw: false,
  group_id: null,
  needs_ai: false,
};
const settings: AppSettings = {
  lastRootPath: null,
  theme: Theme.Dark,
  editInApps: [],
  exportPresets: [
    {
      id: '__last_used__',
      name: '__last_used__',
      fileFormat: 'jpeg',
      jpegQuality: 90,
      enableResize: false,
      resizeMode: 'longEdge',
      resizeValue: 2048,
      dontEnlarge: true,
      keepMetadata: true,
      preserveTimestamps: false,
      stripGps: true,
      filenameTemplate: '{original_filename}_edited',
      enableWatermark: true,
      watermarkPath: 'C:/fixture/watermark.png',
      watermarkAnchor: 'bottomRight',
      watermarkScale: 10,
      watermarkSpacing: 5,
      watermarkOpacity: 75,
      destinationType: 'customFolder',
    },
  ],
};

function snapshot() {
  const ui = useUIStore.getState();
  const editor = useEditorStore.getState();
  return clone({
    activePanel: ui.activePanel,
    renderedPanel: ui.renderedPanel,
    panelModal: ui.panelModal,
    activePanels: ui.activePanels,
    panelLayout: ui.panelLayout,
    isFullLayout: ui.isFullLayout,
    leftPanelWidth: ui.leftPanelWidth,
    rightPanelWidth: ui.rightPanelWidth,
    leftTopHeight: ui.leftTopHeight,
    standalone: isStandaloneCurvesVisible(ui),
    adjustments: editor.adjustments,
    copiedSectionAdjustments: editor.copiedSectionAdjustments,
    isSliderDragging: editor.isSliderDragging,
    isSpeedEditActive: editor.isSpeedEditActive,
    speedEditTarget: editor.speedEditTarget?.current
      ? { label: editor.speedEditTarget.current.label, value: editor.speedEditTarget.current.value }
      : null,
    activeMaskContainerId: editor.activeMaskContainerId,
    exportState: useProcessStore.getState().exportState,
    historyIndex: editor.historyIndex,
  });
}
useUIStore.subscribe(() => record('uiStore', snapshot()));
useEditorStore.subscribe(() => record('editorStore', snapshot()));
useProcessStore.subscribe(() => record('processStore', snapshot()));

function configure(options: ConfigureOptions = {}) {
  debouncedSave.cancel();
  debouncedSetHistory.cancel();
  releaseExport();
  const platform = options.platform ?? 'windows';
  window.__TAURI_OS_PLUGIN_INTERNALS__.platform = platform;
  useSettingsStore.setState({ osPlatform: platform, theme: Theme.Dark, appSettings: clone(settings) });
  const adjustments = clone(INITIAL_ADJUSTMENTS);
  const mask = clone(INITIAL_MASK_CONTAINER);
  mask.id = 'fixture-mask';
  mask.name = 'Fixture mask';
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
    isWaveformVisible: false,
    activeMaskContainerId: null,
  });
  useProcessStore.setState({
    ...initialProcess,
    exportState: { status: Status.Idle, progress: { current: 0, total: 0 }, errorMessage: '' },
  });
  useLibraryStore.setState({ multiSelectedPaths: [], imageList: [clone(libraryImage)], rootPaths: [] });
  const workspace = reconcileWorkspace(undefined, true, platform, options.full !== false);
  flushSync(() =>
    useUIStore.setState({
      ...initialUI,
      ...workspace,
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
const noopAsync = async () => {};
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
const menuProps: Parameters<typeof useAppContextMenus>[0] = {
  handleImageSelect: external('imageSelect'),
  handleBackToLibrary: external('back'),
  handleRenameFiles: external('rename'),
  handleImportClick: external('import'),
  handleLibraryRefresh: noopAsync,
  refreshAllFolderTrees: noopAsync,
  refreshImageList: noopAsync,
  executeDelete: noopAsync,
  handleDeleteRejected: external('deleteRejected'),
  handleTogglePinFolder: noopAsync,
};

function Harness() {
  const ui = useUIStore();
  const editor = useEditorStore();
  const process = useProcessStore();
  const appSettings = useSettingsStore((state) => state.appSettings);
  useKeyboardShortcuts(shortcutProps);
  const menus = useAppContextMenus(menuProps);
  const renderPanel = (panel: Panel, asModal = false) => {
    if (panel === Panel.Curves) return <CurvesPanel />;
    if (panel === Panel.Adjustments) return <Controls />;
    if (panel === Panel.Metadata) return <MetadataPanel />;
    if (panel === Panel.Export)
      return (
        <ExportPanel
          exportState={process.exportState}
          setExportState={process.setExportState}
          selectedImage={editor.selectedImage}
          multiSelectedPaths={[]}
          rootPaths={[]}
          appSettings={appSettings}
          onSettingsChange={(next) => useSettingsStore.getState().setAppSettings(next)}
          isVisible={asModal || !ui.isFullLayout || Object.values(ui.activePanels).includes(panel)}
        />
      );
    // Task 3 leaves the other tools in their existing regions. Placeholders here are explicit,
    // never asserted as real Crop/Masks/AI rendering or backend canvas behavior.
    return (
      <div data-tool-placeholder={panel} className="p-3">
        <p>
          {panel}
          {FIXTURE_LABELS.toolContentSuffix}
        </p>
        <button>{FIXTURE_LABELS.toolButton}</button>
      </div>
    );
  };
  return (
    <main className="flex h-full min-h-0 flex-col bg-bg-primary text-text-primary">
      <div className="flex h-full min-h-0 gap-1 p-2">
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
        <div
          id="canvas-boundary"
          className="relative flex-1 min-w-0"
          onContextMenu={menus.handleEditorContextMenu}
          tabIndex={0}
        >
          {FIXTURE_LABELS.canvas}
          <SpeedEditOverlay />
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
      </div>
      <AppPanelModal panel={ui.panelModal} onClose={() => ui.setUI({ panelModal: null })} renderPanel={renderPanel} />
    </main>
  );
}
configure();
function ProductionProviders() {
  // Match App.tsx's actual layout sensor configuration. DndContext's default
  // zero-distance sensor would consume ordinary tab clicks in this fixture.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  return (
    <DndContext sensors={sensors}>
      <ContextMenuProvider>
        <Harness />
      </ContextMenuProvider>
    </DndContext>
  );
}
createRoot(document.getElementById('root')!).render(<ProductionProviders />);

const api = {
  configure,
  snapshot,
  trace: () => clone(trace),
  mark,
  patchUI(update: Parameters<UIState['setUI']>[0]) {
    flushSync(() => useUIStore.getState().setUI(update));
  },
  setPanel(panel: Panel) {
    useUIStore.getState().setPanel(panel);
  },
  setActivePanel(region: PanelRegion, panel: Panel) {
    useUIStore.getState().setActivePanel(region, panel);
  },
  patchEditor(update: Parameters<EditorState['setEditor']>[0]) {
    useEditorStore.setState(update);
  },
  progress(current: number, total: number) {
    record('mockHostProgress', { current, total });
    useProcessStore.getState().setExportState({ progress: { current, total }, status: Status.Exporting });
  },
  workspace(saved: SavedWorkspace | null, platform = 'windows', full = true) {
    return reconcileWorkspace(saved ?? undefined, true, platform, full);
  },
  baseWorkspace(saved: SavedWorkspace | null) {
    return baseUI.reconcileWorkspace(saved ?? undefined, true);
  },
  baseRoute(panel: Panel) {
    baseUI.useUIStore.setState({ activeView: 'editor' });
    baseUI.useUIStore.getState().setPanel(panel);
    return baseUI.useUIStore.getState().activePanel;
  },
  baseCurveInteraction(mode: Panel) {
    baseUI.useUIStore.setState({ activePanel: mode });
    baseUI.useUIStore.getState().setActivePanel('leftTop', Panel.Curves);
    return { activePanel: baseUI.useUIStore.getState().activePanel };
  },
  isHistoryMode,
  activeTools: () => getActiveTools(useEditorStore.getState().adjustments),
  cleanup() {
    debouncedSave.cancel();
    debouncedSetHistory.cancel();
    releaseExport();
    record('cleanup');
  },
};

declare global {
  interface Window {
    curvesFixture: typeof api;
  }
}
window.curvesFixture = api;
