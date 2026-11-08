import React, { useCallback, useMemo } from 'react';
import { RotateCcw, PencilSparkles, ChartArea } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import CollapsibleSection from '../../ui/CollapsibleSection';
import AdjustmentSection from '../../adjustments/AdjustmentSection';
import ConnectedWaveform from '../editor/ConnectedWaveform';
import Resizer from '../../ui/Resizer';
import {
  ActiveTools,
  Adjustments,
  INITIAL_ADJUSTMENTS,
  ADJUSTMENT_SECTIONS,
  getActiveTools,
  getVisibleAdjustmentSections,
  isToolActive,
} from '../../../utils/adjustments';
import { useContextMenu } from '../../../context/ContextMenuContext';
import { Orientation } from '../../ui/AppProperties';
import Text from '../../ui/Text';
import { TextVariants, TextColors, TextWeights } from '../../../types/typography';
import { useShallow } from 'zustand/react/shallow';
import { canvasToolState, useEditorStore } from '../../../store/useEditorStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { isStandaloneCurvesVisible, useUIStore } from '../../../store/useUIStore';
import { useAdjustmentSectionActions } from '../../../hooks/useAdjustmentSectionActions';
import { buildAutoAdjustModeOptions, useEditorActions } from '../../../hooks/useEditorActions';
import { useWaveformControls } from '../../../hooks/useWaveformControls';

function AdjustmentSectionContent(props: {
  sectionName: string;
  activeTools: ActiveTools;
  onToggleTool(id: string): void;
  [key: string]: unknown;
}) {
  const adjustments = useEditorStore((state) => state.adjustments);
  return <AdjustmentSection {...props} adjustments={adjustments} />;
}

export default function Controls() {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const { isResizingWaveform, onToggleWaveform, setActiveWaveformChannel, handleWaveformResize } =
    useWaveformControls();
  const { setAdjustments, handleAutoAdjustments, handleLutSelect, setLutPreviewOverride } = useEditorActions();
  const { handleSectionContextMenu, handleToggleVisibility } = useAdjustmentSectionActions(setAdjustments);
  const hasStandaloneCurves = useUIStore(isStandaloneCurvesVisible);

  const { appSettings, theme } = useSettingsStore(
    useShallow((state) => ({
      appSettings: state.appSettings,
      theme: state.theme,
    })),
  );

  const visibleSections = getVisibleAdjustmentSections(appSettings?.adjustmentLayout).filter(
    (section) => section !== 'curves' || !hasStandaloneCurves,
  );

  const { collapsibleSectionsState, setUI } = useUIStore(
    useShallow((state) => ({
      collapsibleSectionsState: state.collapsibleSectionsState,
      setUI: state.setUI,
    })),
  );

  const {
    activeToolsState,
    sectionVisibility,
    selectedImage,
    isWbPickerActive,
    isWaveformVisible,
    waveformHeight,
    setEditor,
  } = useEditorStore(
    useShallow((state) => ({
      activeToolsState: state.adjustments.activeTools,
      sectionVisibility: state.adjustments.sectionVisibility,
      selectedImage: state.selectedImage,
      isWbPickerActive: state.isWbPickerActive,
      isWaveformVisible: state.isWaveformVisible,
      waveformHeight: state.waveformHeight,
      setEditor: state.setEditor,
    })),
  );

  const activeTools = useMemo(
    () => getActiveTools({ activeTools: activeToolsState, sectionVisibility }),
    [activeToolsState, sectionVisibility],
  );

  const toggleWbPicker = useCallback(
    () => setEditor((state) => canvasToolState({ isWbPickerActive: !state.isWbPickerActive })),
    [setEditor],
  );

  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );

  const setCollapsibleState = useCallback(
    (updater: any) =>
      setUI((state) => ({
        collapsibleSectionsState: typeof updater === 'function' ? updater(state.collapsibleSectionsState) : updater,
      })),
    [setUI],
  );

  const handleResetAdjustments = () => {
    setAdjustments(
      (prev: Adjustments) => ({
        ...prev,
        ...Object.keys(ADJUSTMENT_SECTIONS)
          .flatMap((s) => ADJUSTMENT_SECTIONS[s])
          .reduce((acc: any, key: string) => {
            acc[key] = INITIAL_ADJUSTMENTS[key as keyof Adjustments];
            return acc;
          }, {}),
        activeTools: { ...INITIAL_ADJUSTMENTS.activeTools },
      }),
      t('contextMenus.editor.resetAdjustments'),
    );
  };

  const handleAutoAdjustContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    showContextMenu(event.clientX, event.clientY, buildAutoAdjustModeOptions(t, handleAutoAdjustments));
  };

  const handleToggleSection = (section: string) => {
    setCollapsibleState((prev: any) => {
      const isOpening = !prev[section];
      if (appSettings?.enableFocusMode && isOpening) {
        const newState = { ...prev };
        Object.keys(newState).forEach((key) => {
          newState[key] = false;
        });
        newState[section] = true;
        return newState;
      }
      return { ...prev, [section]: !prev[section] };
    });
  };

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 flex justify-between items-center shrink-0 border-b border-surface">
        <Text variant={TextVariants.title}>{t('editor.adjustments.title')}</Text>
        <div className="flex items-center gap-1">
          <button
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={() => handleAutoAdjustments()}
            onContextMenu={handleAutoAdjustContextMenu}
            data-tooltip={t('editor.adjustments.tooltips.autoAdjust')}
          >
            <PencilSparkles size={18} />
          </button>
          <button
            className={clsx(
              'p-2 rounded-full transition-colors',
              isWaveformVisible ? 'bg-surface hover:bg-card-active' : 'hover:bg-surface',
            )}
            onClick={onToggleWaveform}
            data-tooltip={t('editor.adjustments.tooltips.toggleAnalytics')}
          >
            <ChartArea size={18} />
          </button>
          <button
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={handleResetAdjustments}
            data-tooltip={t('editor.adjustments.tooltips.resetAdjustments')}
          >
            <RotateCcw size={18} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isWaveformVisible && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: waveformHeight || 256, opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: isResizingWaveform ? 0 : 0.2, ease: 'easeOut' }}
            className="shrink-0 flex flex-col relative border-b border-surface overflow-hidden"
          >
            <div className="grow w-full h-full p-3 pb-2 min-h-0">
              <ConnectedWaveform
                setDisplayMode={setActiveWaveformChannel}
                setAdjustments={setAdjustments}
                theme={theme}
              />
            </div>
            <Resizer direction={Orientation.Horizontal} onMouseDown={handleWaveformResize} />
          </motion.div>
        )}
      </AnimatePresence>

      <div className="grow overflow-y-scroll p-3 flex flex-col gap-2">
        {selectedImage ? (
          visibleSections.map((sectionName: string) => {
            const title = t(`editor.adjustments.sections.${sectionName}`);

            return (
              <div className="shrink-0 group" key={sectionName}>
                <CollapsibleSection
                  isContentVisible={isToolActive(activeTools, sectionName)}
                  isOpen={collapsibleSectionsState[sectionName as keyof typeof collapsibleSectionsState]}
                  onContextMenu={(e) => handleSectionContextMenu(e, sectionName)}
                  onToggle={() => handleToggleSection(sectionName)}
                  onToggleVisibility={() => handleToggleVisibility(sectionName)}
                  title={title}
                >
                  <AdjustmentSectionContent
                    sectionName={sectionName}
                    activeTools={activeTools}
                    onToggleTool={handleToggleVisibility}
                    setAdjustments={setAdjustments}
                    theme={theme}
                    handleLutSelect={handleLutSelect}
                    onLutHover={setLutPreviewOverride}
                    appSettings={appSettings}
                    asShotWhiteBalance={selectedImage.asShotWhiteBalance}
                    isWbPickerActive={isWbPickerActive}
                    toggleWbPicker={toggleWbPicker}
                    onDragStateChange={onDragStateChange}
                  />
                </CollapsibleSection>
              </div>
            );
          })
        ) : (
          <div className="flex items-center justify-center h-full">
            <Text
              variant={TextVariants.heading}
              color={TextColors.secondary}
              weight={TextWeights.normal}
              className="text-center"
            >
              {t('editor.ai.noImageSelected')}
            </Text>
          </div>
        )}
      </div>
    </div>
  );
}
