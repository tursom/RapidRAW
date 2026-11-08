import { RefObject } from 'react';
import { create } from 'zustand';
import {
  Adjustments,
  INITIAL_ADJUSTMENTS,
  MaskContainer,
  AiPatch,
  CropGeometry,
  pickCropGeometry,
} from '../utils/adjustments';
import { SelectedImage, WaveformData, BrushSettings, CompareView, Panel } from '../components/ui/AppProperties';
import { ChannelConfig } from '../components/adjustments/Curves';
import { ImageDimensions } from '../hooks/useImageRenderSize';
import { ToolType } from '../components/panel/right/Masks';
import { OverlayMode } from '../components/panel/right/CropPanel';
import { describeHistoryChange } from '../utils/editHistory';
import { HslMixerProperty } from '../utils/hslMixer';
import type { SpeedEditTarget } from '../components/ui/Slider';
import { isHistoryMode } from '../utils/appMode';

export type CenterMarker = 'vignette' | 'centre';
export type ToolSessionPanel = Panel.Crop | Panel.Masks | Panel.Ai;

interface InteractivePatch {
  url: string;
  normX: number;
  normY: number;
  normW: number;
  normH: number;
}

interface BaseRenderSize extends ImageDimensions {
  containerHeight: number;
  containerWidth: number;
  offsetX: number;
  offsetY: number;
}

interface EditorState {
  // Core Image & Adjustments
  selectedImage: SelectedImage | null;
  adjustments: Adjustments;
  previewOverride: Adjustments | null;

  // History State
  history: Adjustments[];
  historyLabels: string[];
  historyIndex: number;
  historyPath: string | null;
  historyRevision: number;

  // Previews & Overlays
  finalPreviewUrl: string | null;
  uncroppedAdjustedPreviewUrl: string | null;
  interactivePatch: InteractivePatch | null;
  showOriginal: boolean;
  compareView: CompareView;
  splitPosition: number;
  originalPreview: { path: string; url: string | null } | null;

  // Analytics
  histogram: ChannelConfig | null;
  waveform: WaveformData | null;
  isWaveformVisible: boolean;
  activeWaveformChannel: string;
  waveformHeight: number;

  // Interaction State
  isSliderDragging: boolean;
  speedEditTarget: RefObject<SpeedEditTarget | null> | null;
  isSpeedEditActive: boolean;
  zoom: number;
  displaySize: ImageDimensions;
  previewSize: ImageDimensions;
  baseRenderSize: BaseRenderSize;
  originalSize: ImageDimensions;

  // Tools State
  isRotationActive: boolean;
  overlayMode: OverlayMode;
  overlayRotation: number;
  isStraightenActive: boolean;
  isAutoStraightening: boolean;
  isWbPickerActive: boolean;
  isRelightPickerActive: boolean;
  activeRelightLightId: string | null;
  activeCenterMarker: CenterMarker | null;
  mixerPickerProperty: HslMixerProperty | null;
  isGuidedPerspectiveActive: boolean;
  liveRotation: number | null;
  cropSessionSnapshot: { path: string | null; geometry: CropGeometry } | null;
  masksSessionSnapshot: { path: string; masks: Adjustments['masks'] } | null;
  aiSessionSnapshot: { path: string; aiPatches: Adjustments['aiPatches'] } | null;
  toolSessionPanel: ToolSessionPanel | null;
  brushSettings: BrushSettings | null;

  // Masks & AI
  activeMaskContainerId: string | null;
  activeMaskId: string | null;
  activeAiPatchContainerId: string | null;
  activeAiSubMaskId: string | null;
  isMaskControlHovered: boolean;
  isGeneratingAiMask: boolean;
  isGeneratingAi: boolean;
  aiDenoiseProgress: Record<string, number>;
  isAIConnectorConnected: boolean;
  hasRenderedFirstFrame: boolean;
  patchesSentToBackend: Set<string>;

  // Clipboard
  copiedSectionAdjustments: any | null;
  copiedMask: MaskContainer | null;
  copiedAdjustments: Adjustments | null;

  // Actions
  setEditor: (updater: Partial<EditorState> | ((state: EditorState) => Partial<EditorState>)) => void;
  pushHistory: (newAdjustments: Adjustments, label?: string) => void;
  undo: () => void;
  redo: () => void;
  resetHistory: (initialState: Adjustments) => void;
  beginToolSession: (panel: ToolSessionPanel | null) => void;
  goToHistoryIndex: (index: number) => void;
}

type CanvasToolState = Pick<
  EditorState,
  'isWbPickerActive' | 'isRelightPickerActive' | 'activeCenterMarker' | 'mixerPickerProperty'
>;

export const canvasToolState = (activeTool: Partial<CanvasToolState> = {}): CanvasToolState => ({
  isWbPickerActive: false,
  isRelightPickerActive: false,
  activeCenterMarker: null,
  mixerPickerProperty: null,
  ...activeTool,
});

const toolSessionSnapshots = (panel: ToolSessionPanel | null, path: string | null, adjustments: Adjustments) => ({
  cropSessionSnapshot: panel === Panel.Crop && path ? { path, geometry: pickCropGeometry(adjustments) } : null,
  masksSessionSnapshot: panel === Panel.Masks && path ? { path, masks: structuredClone(adjustments.masks) } : null,
  aiSessionSnapshot:
    panel === Panel.Ai && path
      ? {
          path,
          // Loading belongs to the live request; restoring a snapshot must not revive it.
          aiPatches: structuredClone(adjustments.aiPatches)?.map((patch) => ({ ...patch, isLoading: false })),
        }
      : null,
});

export const useEditorStore = create<EditorState>((set) => ({
  selectedImage: null,
  adjustments: INITIAL_ADJUSTMENTS,
  previewOverride: null,
  history: [INITIAL_ADJUSTMENTS],
  historyLabels: [''],
  historyIndex: 0,
  historyPath: null,
  historyRevision: 0,

  finalPreviewUrl: null,
  uncroppedAdjustedPreviewUrl: null,
  showOriginal: false,
  compareView: 'off',
  splitPosition: 0.5,
  originalPreview: null,
  histogram: null,
  waveform: null,
  isWaveformVisible: false,
  activeWaveformChannel: 'luma',
  waveformHeight: 220,

  isSliderDragging: false,
  speedEditTarget: null,
  isSpeedEditActive: false,
  interactivePatch: null,
  activeMaskContainerId: null,
  activeMaskId: null,
  activeAiPatchContainerId: null,
  activeAiSubMaskId: null,

  zoom: 1,
  displaySize: { width: 0, height: 0 },
  previewSize: { width: 0, height: 0 },
  baseRenderSize: { width: 0, height: 0, offsetX: 0, offsetY: 0, containerWidth: 0, containerHeight: 0 },
  originalSize: { width: 0, height: 0 },

  isRotationActive: false,
  overlayMode: 'thirds',
  overlayRotation: 0,
  isStraightenActive: false,
  isAutoStraightening: false,
  isWbPickerActive: false,
  isRelightPickerActive: false,
  activeRelightLightId: null,
  activeCenterMarker: null,
  mixerPickerProperty: null,
  isGuidedPerspectiveActive: false,
  liveRotation: null,
  cropSessionSnapshot: null,
  masksSessionSnapshot: null,
  aiSessionSnapshot: null,
  toolSessionPanel: null,

  copiedSectionAdjustments: null,
  copiedMask: null,
  brushSettings: { size: 100, feather: 50, tool: ToolType.Brush },
  copiedAdjustments: null,

  isGeneratingAiMask: false,
  isAIConnectorConnected: false,
  isGeneratingAi: false,
  aiDenoiseProgress: {},
  isMaskControlHovered: false,
  hasRenderedFirstFrame: false,
  patchesSentToBackend: new Set<string>(),

  setEditor: (updater) =>
    set((state) => {
      const updates = typeof updater === 'function' ? updater(state) : updater;
      if (isHistoryMode() && 'selectedImage' in updates && updates.selectedImage?.path !== state.selectedImage?.path) {
        // Navigation installs selectedImage before its adjustments (even on a cache hit).
        return { ...updates, ...toolSessionSnapshots(null, null, state.adjustments), historyPath: null };
      }
      return updates;
    }),

  beginToolSession: (panel) =>
    set((state) => {
      if (!isHistoryMode() || panel === state.toolSessionPanel) return state;
      const path = state.selectedImage?.path ?? null;
      return {
        toolSessionPanel: panel,
        ...toolSessionSnapshots(panel, path === state.historyPath ? path : null, state.adjustments),
      };
    }),

  pushHistory: (newAdj, label) =>
    set((state) => {
      if (isHistoryMode() && JSON.stringify(state.history[state.historyIndex]) === JSON.stringify(newAdj)) return state;
      const newHistory = state.history.slice(0, state.historyIndex + 1);
      const newLabels = state.historyLabels.slice(0, state.historyIndex + 1);
      newLabels.push(label || describeHistoryChange(state.history[state.historyIndex], newAdj));
      newHistory.push(newAdj);
      if (newHistory.length > 50) {
        newHistory.shift();
        newLabels.shift();
      }
      return { history: newHistory, historyLabels: newLabels, historyIndex: newHistory.length - 1 };
    }),

  undo: () =>
    set((state) => {
      if (state.historyIndex > 0) {
        const newIndex = state.historyIndex - 1;
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    }),

  redo: () =>
    set((state) => {
      if (state.historyIndex < state.history.length - 1) {
        const newIndex = state.historyIndex + 1;
        return { historyIndex: newIndex, adjustments: state.history[newIndex] };
      }
      return state;
    }),

  resetHistory: (initialState) =>
    set((state) => ({
      history: [initialState],
      historyLabels: [''],
      historyIndex: 0,
      adjustments: initialState,
      ...(isHistoryMode()
        ? {
            historyPath: state.selectedImage?.path ?? null,
            historyRevision: state.historyRevision + 1,
            ...toolSessionSnapshots(state.toolSessionPanel, state.selectedImage?.path ?? null, initialState),
          }
        : state.cropSessionSnapshot
          ? {
              cropSessionSnapshot: {
                path: state.selectedImage?.path ?? null,
                geometry: pickCropGeometry(initialState),
              },
            }
          : {}),
    })),

  goToHistoryIndex: (index) =>
    set((state) => {
      if (index >= 0 && index < state.history.length) {
        return { historyIndex: index, adjustments: state.history[index] };
      }
      return state;
    }),
}));
