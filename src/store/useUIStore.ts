import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import i18n from 'i18next';
import { toast } from 'react-toastify';
import {
  Invokes,
  ImageFile,
  Panel,
  UiVisibility,
  CullingSuggestions,
  PanelRegion,
  WorkspaceState,
  CollapsibleSectionsState,
} from '../components/ui/AppProperties';
import { useEditorStore, type ToolSessionPanel } from './useEditorStore';
import { useSettingsStore } from './useSettingsStore';
import { pickCropGeometry } from '../utils/adjustments';
import { isHistoryMode } from '../utils/appMode';

export type SwitcherPlacement = 'bottom' | 'right' | 'left' | 'top';

export interface CropSectionsState {
  transform: boolean;
  lens: boolean;
}

interface ConfirmModalState {
  confirmText?: string;
  confirmVariant?: string;
  isOpen: boolean;
  message?: string;
  onConfirm?(): void;
  title?: string;
}

interface CollageModalState {
  isOpen: boolean;
  sourceImages: Array<Pick<ImageFile, 'path'>>;
}

interface PanoramaModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

interface FocusStackModalState {
  error: string | null;
  finalImageBase64: string | null;
  depthMapBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  sourcePaths: Array<string>;
}

interface HdrModalState {
  error: string | null;
  finalImageBase64: string | null;
  isOpen: boolean;
  isProcessing: boolean;
  progressMessage: string | null;
  stitchingSourcePaths: Array<string>;
}

interface CullingModalState {
  isOpen: boolean;
  suggestions: CullingSuggestions | null;
  progress: { current: number; total: number; stage: string } | null;
  error: string | null;
  pathsToCull: Array<string>;
}

const ALL_PANELS: Panel[] = [
  Panel.Curves,
  Panel.Metadata,
  Panel.FolderTree,
  Panel.Export,
  Panel.Tethering,
  Panel.Adjustments,
  Panel.Crop,
  Panel.Masks,
  Panel.Ai,
  Panel.Presets,
];

const DEFAULT_PANEL_DEFAULT_REGIONS: Record<Panel, PanelRegion> = {
  [Panel.Curves]: 'leftTop',
  [Panel.Metadata]: 'leftTop',
  [Panel.FolderTree]: 'leftTop',
  [Panel.Export]: 'leftTop',
  [Panel.Tethering]: 'leftTop',
  [Panel.Adjustments]: 'rightTop',
  [Panel.Crop]: 'rightTop',
  [Panel.Masks]: 'rightTop',
  [Panel.Ai]: 'rightTop',
  [Panel.Presets]: 'rightTop',
};

export const DEFAULT_PANEL_WIDTH = 350;
export const DEFAULT_LEFT_PANEL_WIDTH = 250;
export const DEFAULT_RIGHT_PANEL_WIDTH = 320;
export const DEFAULT_PANEL_SECTION_HEIGHT = 450;
export const DEFAULT_LEFT_PANEL_SECTION_HEIGHT = 340;
export const DEFAULT_BOTTOM_PANEL_HEIGHT = 144;
const MIN_REOPENED_PANEL_WIDTH = 250;

export const getReopenedPanelWidth = (width: number, side?: 'left' | 'right') => {
  const defaultWidth =
    side && isHistoryMode()
      ? side === 'left'
        ? DEFAULT_LEFT_PANEL_WIDTH
        : DEFAULT_RIGHT_PANEL_WIDTH
      : DEFAULT_PANEL_WIDTH;
  return width < MIN_REOPENED_PANEL_WIDTH ? defaultWidth : width;
};

const isModalPanel = (panel: Panel): panel is Panel.Metadata | Panel.Export =>
  panel === Panel.Metadata || panel === Panel.Export;

const getDockPanels = (panels: Panel[], usePanelModals: boolean) =>
  usePanelModals ? panels.filter((panel) => !isModalPanel(panel)) : panels;

const isToolPanel = (panel: Panel | null): panel is ToolSessionPanel =>
  panel === Panel.Crop || panel === Panel.Masks || panel === Panel.Ai;

const isFixedToolLayout = (state: Pick<UIState, 'isFullLayout'>) => isHistoryMode() && state.isFullLayout;

export function reconcileWorkspace(
  savedWorkspace: WorkspaceState | undefined,
  isTetheringSupported: boolean,
  osPlatform = useSettingsStore.getState().osPlatform,
  isFullLayout = true,
): WorkspaceState {
  const historyMode = isHistoryMode(osPlatform);
  const fixedToolLayout = historyMode && isFullLayout;
  const allowedPanels = new Set(
    ALL_PANELS.filter(
      (panel) => (panel !== Panel.Curves || historyMode) && (panel !== Panel.Tethering || isTetheringSupported),
    ),
  );

  const defaultWorkspace: WorkspaceState = {
    leftPanelWidth: historyMode ? DEFAULT_LEFT_PANEL_WIDTH : DEFAULT_PANEL_WIDTH,
    rightPanelWidth: historyMode ? DEFAULT_RIGHT_PANEL_WIDTH : DEFAULT_PANEL_WIDTH,
    leftTopHeight: historyMode ? DEFAULT_LEFT_PANEL_SECTION_HEIGHT : DEFAULT_PANEL_SECTION_HEIGHT,
    rightTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
    panelLayout: {
      leftTop: [
        ...(historyMode ? [Panel.Curves] : []),
        Panel.Metadata,
        Panel.FolderTree,
        Panel.Export,
        ...(isTetheringSupported ? [Panel.Tethering] : []),
      ],
      leftBottom: fixedToolLayout ? [Panel.Crop, Panel.Masks, Panel.Ai, Panel.Presets] : [],
      rightTop: fixedToolLayout
        ? [Panel.Adjustments]
        : [Panel.Adjustments, Panel.Crop, Panel.Masks, Panel.Ai, Panel.Presets],
      rightBottom: [],
    },
    activePanels: {
      leftTop: historyMode ? Panel.Curves : Panel.FolderTree,
      leftBottom: fixedToolLayout ? Panel.Presets : null,
      rightTop: Panel.Adjustments,
      rightBottom: null,
    },
    panelSwitcherPlacement: {
      leftTop: 'bottom',
      leftBottom: 'bottom',
      rightTop: 'right',
      rightBottom: 'right',
    },
  };

  if (fixedToolLayout) {
    return {
      ...defaultWorkspace,
      leftPanelWidth: savedWorkspace?.leftPanelWidth ?? defaultWorkspace.leftPanelWidth,
      rightPanelWidth: savedWorkspace?.rightPanelWidth ?? defaultWorkspace.rightPanelWidth,
      leftTopHeight: savedWorkspace?.leftTopHeight ?? defaultWorkspace.leftTopHeight,
      rightTopHeight: savedWorkspace?.rightTopHeight ?? defaultWorkspace.rightTopHeight,
    };
  }

  if (!savedWorkspace || !savedWorkspace.panelLayout) {
    return defaultWorkspace;
  }

  const seenPanels = new Set<Panel>();
  const sanitizedLayout: Record<PanelRegion, Panel[]> = {
    leftTop: [],
    leftBottom: [],
    rightTop: [],
    rightBottom: [],
  };

  (['leftTop', 'leftBottom', 'rightTop', 'rightBottom'] as PanelRegion[]).forEach((region) => {
    const list = savedWorkspace.panelLayout[region] || [];
    list.forEach((panel) => {
      if (allowedPanels.has(panel) && !seenPanels.has(panel)) {
        sanitizedLayout[region].push(panel);
        seenPanels.add(panel);
      }
    });
  });

  const needsCurvesMigration = historyMode && !seenPanels.has(Panel.Curves);
  if (needsCurvesMigration) {
    sanitizedLayout.leftTop.unshift(Panel.Curves);
    seenPanels.add(Panel.Curves);
  }

  allowedPanels.forEach((panel) => {
    if (!seenPanels.has(panel)) {
      const targetRegion = DEFAULT_PANEL_DEFAULT_REGIONS[panel] || 'leftTop';
      sanitizedLayout[targetRegion].push(panel);
      seenPanels.add(panel);
    }
  });

  if (historyMode) {
    (['leftBottom', 'rightTop', 'rightBottom'] as PanelRegion[]).forEach((region) => {
      const modalPanels = sanitizedLayout[region].filter(isModalPanel);
      sanitizedLayout[region] = sanitizedLayout[region].filter((panel) => !isModalPanel(panel));
      sanitizedLayout.leftTop.push(...modalPanels);
    });
  }

  const sanitizedActive: Record<PanelRegion, Panel | null> = {
    leftTop: null,
    leftBottom: null,
    rightTop: null,
    rightBottom: null,
  };

  (['leftTop', 'leftBottom', 'rightTop', 'rightBottom'] as PanelRegion[]).forEach((region) => {
    const currentActive = savedWorkspace.activePanels?.[region];
    const dockPanels = getDockPanels(sanitizedLayout[region], historyMode && isFullLayout);
    if (needsCurvesMigration && region === 'leftTop') {
      sanitizedActive[region] = Panel.Curves;
    } else if (currentActive && dockPanels.includes(currentActive)) {
      sanitizedActive[region] = currentActive;
    } else {
      sanitizedActive[region] = dockPanels[0] ?? null;
    }
  });

  return {
    leftPanelWidth: savedWorkspace.leftPanelWidth || defaultWorkspace.leftPanelWidth,
    rightPanelWidth: savedWorkspace.rightPanelWidth || defaultWorkspace.rightPanelWidth,
    leftTopHeight: savedWorkspace.leftTopHeight || defaultWorkspace.leftTopHeight,
    rightTopHeight: savedWorkspace.rightTopHeight || defaultWorkspace.rightTopHeight,
    panelLayout: sanitizedLayout,
    activePanels: sanitizedActive,
    panelSwitcherPlacement: {
      ...defaultWorkspace.panelSwitcherPlacement,
      ...(savedWorkspace.panelSwitcherPlacement || {}),
    },
  };
}

export const isPanelVisible = (state: UIState, panel: Panel) =>
  isHistoryMode() && !state.isFullLayout
    ? state.activePanel === panel
    : (Object.keys(state.activePanels) as PanelRegion[]).some(
        (region) =>
          state.activePanels[region] === panel &&
          state.uiVisibility[region.startsWith('left') ? 'leftPanel' : 'rightPanel'],
      );

export const isStandaloneCurvesVisible = (state: UIState) =>
  isHistoryMode() &&
  state.isFullLayout &&
  !state.isFullScreen &&
  isPanelVisible(state, Panel.Curves) &&
  (Object.keys(state.activePanels) as PanelRegion[]).some((region) => {
    const isLeft = region.startsWith('left');
    return (
      state.activePanels[region] === Panel.Curves &&
      state.uiVisibility[isLeft ? 'leftPanel' : 'rightPanel'] &&
      (isLeft ? state.leftPanelWidth : state.rightPanelWidth) >= 200
    );
  });

const getPanelModalUpdate = (state: UIState, panel: Panel): Partial<UIState> | null => {
  if (!isHistoryMode() || !state.isFullLayout || !isModalPanel(panel)) return null;
  if (state.activeView === 'editor' && !useEditorStore.getState().selectedImage) return {};
  return { panelModal: panel };
};

export interface UIState {
  activeView: string;
  isFullLayout: boolean;
  panelModal: Panel.Metadata | Panel.Export | null;
  isFullScreen: boolean;
  isWindowFullScreen: boolean;
  isViewerOpen: boolean;
  isInstantTransition: boolean;
  isLayoutReady: boolean;
  uiVisibility: UiVisibility;
  isLibraryExportPanelVisible: boolean;
  isSettingsOpen: boolean;

  leftPanelWidth: number;
  rightPanelWidth: number;
  bottomPanelHeight: number;
  leftTopHeight: number;
  rightTopHeight: number;
  compactEditorPanelHeightOverride: number | null;

  panelLayout: Record<PanelRegion, Panel[]>;
  activePanels: Record<PanelRegion, Panel | null>;
  activeLayoutDragItem: Panel | null;
  setLayoutDragItem: (panel: Panel | null) => void;
  movePanel: (panel: Panel, toRegion: PanelRegion) => void;
  movePanelToIndex: (panel: Panel, toRegion: PanelRegion, index: number) => void;
  setActivePanel: (region: PanelRegion, panel: Panel | null) => void;

  panelSwitcherPlacement: Record<PanelRegion, SwitcherPlacement>;
  setPanelSwitcherPlacement: (region: PanelRegion, placement: SwitcherPlacement) => void;

  activePanel: Panel | null;
  renderedPanel: Panel | null;
  slideDirection: number;
  collapsibleSectionsState: CollapsibleSectionsState;
  isColorGradingExpanded: boolean;
  isColorMixerExpanded: boolean;
  cropSectionsState: CropSectionsState;

  isCreateFolderModalOpen: boolean;
  isRenameFolderModalOpen: boolean;
  isRenameFileModalOpen: boolean;
  renameTargetPaths: Array<string>;
  isImportModalOpen: boolean;
  isCopyPasteSettingsModalOpen: boolean;
  importTargetFolder: string | null;
  importSourcePaths: Array<string>;
  folderActionTarget: string | null;

  isCreateAlbumModalOpen: boolean;
  isCreateAlbumGroupModalOpen: boolean;
  isRenameAlbumModalOpen: boolean;
  albumActionTarget: string | null;

  confirmModalState: ConfirmModalState;
  panoramaModalState: PanoramaModalState;
  focusStackModalState: FocusStackModalState;
  hdrModalState: HdrModalState;
  cullingModalState: CullingModalState;
  collageModalState: CollageModalState;

  setUI: (updater: Partial<UIState> | ((state: UIState) => Partial<UIState>)) => void;
  setPanel: (panel: Panel | null) => void;
  customEscapeHandler: (() => void) | null;
  setCustomEscapeHandler: (handler: (() => void) | null) => void;
  imageSelectHandler: ((path: string, openInEditor?: boolean) => void) | null;
  setImageSelectHandler: (handler: ((path: string, openInEditor?: boolean) => void) | null) => void;
  searchFocusRequest: number;
  requestSearchFocus: () => void;
  toggleFullScreen: () => void;
  toggleViewerWindow: () => void;
  resetWorkspaceLayout: (isTetheringSupported?: boolean) => WorkspaceState;
}

export const useUIStore = create<UIState>((set, get) => ({
  activeView: 'library',
  isFullLayout: true,
  panelModal: null,
  isFullScreen: false,
  isWindowFullScreen: false,
  isViewerOpen: false,
  isInstantTransition: false,
  isLayoutReady: false,
  uiVisibility: { filmstrip: true, leftPanel: true, rightPanel: true, quickFilter: false },
  isLibraryExportPanelVisible: false,
  isSettingsOpen: false,

  leftPanelWidth: DEFAULT_PANEL_WIDTH,
  rightPanelWidth: DEFAULT_PANEL_WIDTH,
  bottomPanelHeight: DEFAULT_BOTTOM_PANEL_HEIGHT,
  leftTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
  rightTopHeight: DEFAULT_PANEL_SECTION_HEIGHT,
  compactEditorPanelHeightOverride: null,

  panelLayout: {
    leftTop: [Panel.Metadata, Panel.FolderTree, Panel.Export],
    leftBottom: [],
    rightTop: [Panel.Adjustments, Panel.Crop, Panel.Masks, Panel.Ai, Panel.Presets],
    rightBottom: [],
  },
  activePanels: {
    leftTop: Panel.FolderTree,
    leftBottom: null,
    rightTop: Panel.Adjustments,
    rightBottom: null,
  },
  activeLayoutDragItem: null,

  panelSwitcherPlacement: {
    leftTop: 'bottom',
    leftBottom: 'bottom',
    rightTop: 'right',
    rightBottom: 'right',
  },
  setPanelSwitcherPlacement: (region, placement) =>
    set((state) =>
      isFixedToolLayout(state)
        ? state
        : { panelSwitcherPlacement: { ...state.panelSwitcherPlacement, [region]: placement } },
    ),

  activePanel: Panel.Adjustments,
  renderedPanel: Panel.Adjustments,
  slideDirection: 1,
  collapsibleSectionsState: { basic: true, color: false, curves: true, details: false, effects: false },
  isColorGradingExpanded: false,
  isColorMixerExpanded: false,
  cropSectionsState: { transform: false, lens: false },

  isCreateFolderModalOpen: false,
  isRenameFolderModalOpen: false,
  isRenameFileModalOpen: false,
  renameTargetPaths: [],
  isImportModalOpen: false,
  isCopyPasteSettingsModalOpen: false,
  importTargetFolder: null,
  importSourcePaths: [],
  folderActionTarget: null,
  isCreateAlbumModalOpen: false,
  isCreateAlbumGroupModalOpen: false,
  isRenameAlbumModalOpen: false,
  albumActionTarget: null,

  confirmModalState: { isOpen: false },
  panoramaModalState: {
    error: null,
    finalImageBase64: null,
    isOpen: false,
    isProcessing: false,
    progressMessage: '',
    stitchingSourcePaths: [],
  },
  focusStackModalState: {
    error: null,
    finalImageBase64: null,
    depthMapBase64: null,
    isOpen: false,
    isProcessing: false,
    progressMessage: '',
    sourcePaths: [],
  },
  hdrModalState: {
    error: null,
    finalImageBase64: null,
    isOpen: false,
    isProcessing: false,
    progressMessage: '',
    stitchingSourcePaths: [],
  },
  cullingModalState: { isOpen: false, suggestions: null, progress: null, error: null, pathsToCull: [] },
  collageModalState: { isOpen: false, sourceImages: [] },

  setUI: (updater) =>
    set((state) => {
      const updates = typeof updater === 'function' ? updater(state) : updater;
      if (!isHistoryMode()) return updates;
      const nextIsFullLayout = updates.isFullLayout ?? state.isFullLayout;
      if (!nextIsFullLayout) {
        // Compact panels render the global selection, not the full layout's regional selection.
        return state.isFullLayout ? { ...updates, panelModal: null } : updates;
      }
      if (state.isFullLayout && !updates.panelLayout) return updates;

      // Initialization also writes a workspace while already full; normalize its mode as well.
      const next = { ...state, ...updates };
      const workspace = reconcileWorkspace(
        next,
        Object.values(next.panelLayout).some((panels) => panels.includes(Panel.Tethering)),
      );
      const activePanel =
        isToolPanel(next.activePanel) && useEditorStore.getState().selectedImage ? next.activePanel : Panel.Adjustments;
      return {
        ...updates,
        ...workspace,
        activePanels: { ...workspace.activePanels, leftBottom: isToolPanel(activePanel) ? activePanel : Panel.Presets },
        activePanel,
        renderedPanel: activePanel,
        activeLayoutDragItem: null,
      };
    }),

  setLayoutDragItem: (panel) => set((state) => ({ activeLayoutDragItem: isFixedToolLayout(state) ? null : panel })),

  movePanel: (panel, toRegion) =>
    set((state) => {
      if (isFixedToolLayout(state)) return state;
      if (panel === Panel.Curves && (!isHistoryMode() || !state.isFullLayout)) return state;
      const layout = {
        leftTop: [...state.panelLayout.leftTop],
        leftBottom: [...state.panelLayout.leftBottom],
        rightTop: [...state.panelLayout.rightTop],
        rightBottom: [...state.panelLayout.rightBottom],
      };
      const active = { ...state.activePanels };

      let fromRegion: PanelRegion | null = null;
      for (const r of Object.keys(layout) as PanelRegion[]) {
        if (layout[r].includes(panel)) {
          fromRegion = r;
          layout[r] = layout[r].filter((p) => p !== panel);
        }
      }

      if (!layout[toRegion].includes(panel)) layout[toRegion].push(panel);

      if (fromRegion && active[fromRegion] === panel) {
        active[fromRegion] = getDockPanels(layout[fromRegion], isHistoryMode() && state.isFullLayout)[0] ?? null;
      }

      active[toRegion] = panel;

      return {
        panelLayout: layout,
        activePanels: active,
        activeLayoutDragItem: null,
        ...(panel === Panel.Curves ? {} : { activePanel: panel, renderedPanel: panel }),
      };
    }),

  movePanelToIndex: (panel, toRegion, index) =>
    set((state) => {
      if (isFixedToolLayout(state)) return state;
      if (panel === Panel.Curves && (!isHistoryMode() || !state.isFullLayout)) return state;
      const layout = {
        leftTop: [...state.panelLayout.leftTop],
        leftBottom: [...state.panelLayout.leftBottom],
        rightTop: [...state.panelLayout.rightTop],
        rightBottom: [...state.panelLayout.rightBottom],
      };
      const active = { ...state.activePanels };

      let fromRegion: PanelRegion | null = null;
      for (const r of Object.keys(layout) as PanelRegion[]) {
        if (layout[r].includes(panel)) {
          fromRegion = r;
          layout[r] = layout[r].filter((p) => p !== panel);
        }
      }

      const clampedIndex = Math.max(0, Math.min(index, layout[toRegion].length));
      layout[toRegion].splice(clampedIndex, 0, panel);

      if (fromRegion && active[fromRegion] === panel) {
        active[fromRegion] = getDockPanels(layout[fromRegion], isHistoryMode() && state.isFullLayout)[0] ?? null;
      }
      active[toRegion] = panel;

      return {
        panelLayout: layout,
        activePanels: active,
        activeLayoutDragItem: null,
        ...(panel === Panel.Curves ? {} : { activePanel: panel, renderedPanel: panel }),
      };
    }),

  setActivePanel: (region, panel) =>
    set((state) => {
      if (!panel) return state;
      const modalUpdate = getPanelModalUpdate(state, panel);
      if (modalUpdate !== null) return modalUpdate;
      if (panel === Panel.Curves && (!isHistoryMode() || !state.isFullLayout)) return state;
      const fixedToolLayout = isFixedToolLayout(state);
      if (fixedToolLayout && !state.panelLayout[region].includes(panel)) return state;
      if (fixedToolLayout && isToolPanel(panel) && !useEditorStore.getState().selectedImage) return state;
      const globalPanel = fixedToolLayout && panel === Panel.Presets ? Panel.Adjustments : panel;
      const updates: Partial<UIState> = {
        activePanels: { ...state.activePanels, [region]: panel },
        ...(panel === Panel.Curves || (fixedToolLayout && region !== 'leftBottom')
          ? {}
          : { activePanel: globalPanel, renderedPanel: globalPanel }),
      };

      const isLeft = region === 'leftTop' || region === 'leftBottom';
      const isRight = region === 'rightTop' || region === 'rightBottom';

      if (isLeft && (!state.uiVisibility.leftPanel || (fixedToolLayout && state.leftPanelWidth < 200))) {
        updates.uiVisibility = { ...state.uiVisibility, leftPanel: true };
        if (isHistoryMode()) {
          updates.leftPanelWidth = getReopenedPanelWidth(state.leftPanelWidth, 'left');
        } else if (state.leftPanelWidth < DEFAULT_PANEL_WIDTH) {
          updates.leftPanelWidth = DEFAULT_PANEL_WIDTH;
        }
      }

      if (isRight && (!state.uiVisibility.rightPanel || (fixedToolLayout && state.rightPanelWidth < 200))) {
        updates.uiVisibility = { ...state.uiVisibility, rightPanel: true };
        if (isHistoryMode()) {
          updates.rightPanelWidth = getReopenedPanelWidth(state.rightPanelWidth, 'right');
        } else if (state.rightPanelWidth < DEFAULT_PANEL_WIDTH) {
          updates.rightPanelWidth = DEFAULT_PANEL_WIDTH;
        }
      }

      return updates;
    }),

  setPanel: (panelId) => {
    const state = get();
    if (!panelId) return;
    const modalUpdate = getPanelModalUpdate(state, panelId);
    if (modalUpdate !== null) {
      set(modalUpdate);
      return;
    }

    if (isFixedToolLayout(state) && panelId === Panel.Adjustments) {
      // This explicit command exits a tool; interacting with Adjustments content does not.
      set({
        activePanels: { ...state.activePanels, leftBottom: Panel.Presets },
        activePanel: Panel.Adjustments,
        renderedPanel: Panel.Adjustments,
      });
    }

    let targetRegion: PanelRegion | null = null;
    for (const region of Object.keys(state.panelLayout) as PanelRegion[]) {
      if (state.panelLayout[region].includes(panelId)) {
        targetRegion = region;
        break;
      }
    }
    if (targetRegion) state.setActivePanel(targetRegion, panelId);
  },

  toggleFullScreen: () => {
    const { isFullScreen } = get();
    const { zoom, selectedImage } = useEditorStore.getState();

    const isNotFitToScreen = Math.abs(zoom - 1) > 0.01;
    set({ isInstantTransition: isNotFitToScreen });

    if (isFullScreen) {
      set({ isFullScreen: false });
    } else {
      if (!selectedImage) return;
      set({ isFullScreen: true });
    }

    if (isNotFitToScreen) {
      setTimeout(() => set({ isInstantTransition: false }), 100);
    }
  },

  toggleViewerWindow: () => {
    if (get().isViewerOpen) {
      set({ isViewerOpen: false });
      invoke(Invokes.CloseViewerWindow).catch(console.error);
      return;
    }
    invoke(Invokes.OpenViewerWindow, { title: i18n.t('editor.viewer.windowTitle') })
      .then(() => set({ isViewerOpen: true }))
      .catch((err) => toast.error(i18n.t('editor.viewer.openFailed', { error: String(err) })));
  },

  resetWorkspaceLayout: (isTetheringSupported = false) => {
    const defaultWorkspace = reconcileWorkspace(
      undefined,
      isTetheringSupported,
      useSettingsStore.getState().osPlatform,
      get().isFullLayout,
    );
    set({
      leftPanelWidth: defaultWorkspace.leftPanelWidth,
      rightPanelWidth: defaultWorkspace.rightPanelWidth,
      leftTopHeight: defaultWorkspace.leftTopHeight,
      rightTopHeight: defaultWorkspace.rightTopHeight,
      panelLayout: defaultWorkspace.panelLayout,
      activePanels: defaultWorkspace.activePanels,
      panelSwitcherPlacement: defaultWorkspace.panelSwitcherPlacement,
      uiVisibility: { filmstrip: true, leftPanel: true, rightPanel: true, quickFilter: false },
      activePanel: defaultWorkspace.activePanels.rightTop || null,
      renderedPanel: defaultWorkspace.activePanels.rightTop || null,
    });
    return defaultWorkspace;
  },

  customEscapeHandler: null,
  setCustomEscapeHandler: (handler) => set({ customEscapeHandler: handler }),
  imageSelectHandler: null,
  setImageSelectHandler: (handler) => set({ imageSelectHandler: handler }),
  searchFocusRequest: 0,
  requestSearchFocus: () => set((state) => ({ searchFocusRequest: state.searchFocusRequest + 1 })),
}));

useUIStore.subscribe((state, prev) => {
  if (state.activePanel === prev.activePanel) return;
  if (isHistoryMode()) {
    useEditorStore.getState().beginToolSession(isToolPanel(state.activePanel) ? state.activePanel : null);
    return;
  }
  const { selectedImage, adjustments, setEditor } = useEditorStore.getState();
  if (state.activePanel === Panel.Crop) {
    setEditor({
      cropSessionSnapshot: { path: selectedImage?.path ?? null, geometry: pickCropGeometry(adjustments) },
    });
  } else if (prev.activePanel === Panel.Crop) {
    setEditor({ cropSessionSnapshot: null });
  }
});

useEditorStore.subscribe((state, prev) => {
  if (state.selectedImage || !prev.selectedImage) return;
  const ui = useUIStore.getState();
  if (!isFixedToolLayout(ui)) return;
  if (!isToolPanel(ui.activePanel) && !isToolPanel(ui.activePanels.leftBottom)) return;
  ui.setUI({
    activePanels: { ...ui.activePanels, leftBottom: Panel.Presets },
    activePanel: Panel.Adjustments,
    renderedPanel: Panel.Adjustments,
  });
});
