import { useCallback, useMemo } from 'react';
import { FileInput, Info } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import AdjustmentSection from '../../adjustments/AdjustmentSection';
import { Panel } from '../../ui/AppProperties';
import Text from '../../ui/Text';
import VisibilityToggle, { HIDDEN_CONTENT_CLASS } from '../../ui/VisibilityToggle';
import { useAdjustmentSectionActions } from '../../../hooks/useAdjustmentSectionActions';
import { useEditorActions } from '../../../hooks/useEditorActions';
import { useEditorStore } from '../../../store/useEditorStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useUIStore } from '../../../store/useUIStore';
import { TextColors, TextVariants, TextWeights } from '../../../types/typography';
import { getActiveTools, isToolActive } from '../../../utils/adjustments';

export default function CurvesPanel() {
  const { t } = useTranslation();
  const { setAdjustments } = useEditorActions();
  const { handleSectionContextMenu, handleToggleVisibility } = useAdjustmentSectionActions(setAdjustments);
  const setPanel = useUIStore((state) => state.setPanel);
  const theme = useSettingsStore((state) => state.theme);
  const { adjustments, selectedImage, setEditor } = useEditorStore(
    useShallow((state) => ({
      adjustments: state.adjustments,
      selectedImage: state.selectedImage,
      setEditor: state.setEditor,
    })),
  );
  const activeTools = useMemo(
    () => getActiveTools({ activeTools: adjustments.activeTools, sectionVisibility: adjustments.sectionVisibility }),
    [adjustments.activeTools, adjustments.sectionVisibility],
  );
  const isContentVisible = isToolActive(activeTools, 'curves');
  const onDragStateChange = useCallback(
    (isDragging: boolean) => setEditor({ isSliderDragging: isDragging }),
    [setEditor],
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div
        className="p-3 flex justify-between items-center shrink-0 border-b border-surface"
        onContextMenu={(event) => handleSectionContextMenu(event, 'curves')}
      >
        <div className="flex items-center gap-2">
          <Text variant={TextVariants.title}>{t('editor.adjustments.sections.curves')}</Text>
          <VisibilityToggle isVisible={isContentVisible} onToggle={() => handleToggleVisibility('curves')} />
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={() => setPanel(Panel.Metadata)}
            aria-label={t('editor.switcher.tooltips.info')}
            data-tooltip={t('editor.switcher.tooltips.info')}
          >
            <Info size={18} />
          </button>
          <button
            type="button"
            className="p-2 rounded-full hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            disabled={!selectedImage}
            onClick={() => setPanel(Panel.Export)}
            aria-label={t('editor.switcher.tooltips.export')}
            data-tooltip={t('editor.switcher.tooltips.export')}
          >
            <FileInput size={18} />
          </button>
        </div>
      </div>
      <div className="grow min-h-0 overflow-y-auto p-3">
        {selectedImage ? (
          <div className={clsx('transition-opacity duration-300', !isContentVisible && HIDDEN_CONTENT_CLASS)}>
            <AdjustmentSection
              sectionName="curves"
              activeTools={activeTools}
              onToggleTool={handleToggleVisibility}
              adjustments={adjustments}
              setAdjustments={setAdjustments}
              theme={theme}
              onDragStateChange={onDragStateChange}
            />
          </div>
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
