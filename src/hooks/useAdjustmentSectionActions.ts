import { useCallback } from 'react';
import type { MouseEvent } from 'react';
import { ClipboardPaste, Copy, LayoutList, RotateCcw } from 'lucide-react';
import type { ParseKeys } from 'i18next';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import AdjustmentSectionsSubMenu from '../components/panel/right/AdjustmentSectionsSubMenu';
import { OPTION_SEPARATOR } from '../components/ui/AppProperties';
import type { Option } from '../components/ui/AppProperties';
import { useContextMenu } from '../context/ContextMenuContext';
import { useEditorStore } from '../store/useEditorStore';
import {
  ADJUSTMENT_SECTIONS,
  INITIAL_ADJUSTMENTS,
  getActiveTools,
  setToolActive,
  toggleToolActive,
} from '../utils/adjustments';
import type { Adjustments } from '../utils/adjustments';
import type { useEditorActions } from './useEditorActions';

export function useAdjustmentSectionActions(setAdjustments: ReturnType<typeof useEditorActions>['setAdjustments']) {
  const { t } = useTranslation();
  const { showContextMenu } = useContextMenu();
  const { copiedSectionAdjustments, setEditor } = useEditorStore(
    useShallow((state) => ({
      copiedSectionAdjustments: state.copiedSectionAdjustments,
      setEditor: state.setEditor,
    })),
  );

  const handleToggleVisibility = useCallback(
    (id: string) => {
      setAdjustments((prev) => ({
        ...prev,
        activeTools: toggleToolActive(getActiveTools(prev), id),
      }));
    },
    [setAdjustments],
  );

  const handleSectionContextMenu = useCallback(
    (event: MouseEvent, sectionName: string) => {
      event.preventDefault();
      event.stopPropagation();

      const sectionKeys = ADJUSTMENT_SECTIONS[sectionName];
      if (!sectionKeys) {
        return;
      }

      const handleCopy = () => {
        const { adjustments } = useEditorStore.getState();
        const values = Object.fromEntries(
          sectionKeys
            .filter((key) => Object.prototype.hasOwnProperty.call(adjustments, key))
            .map((key) => [key, JSON.parse(JSON.stringify(adjustments[key as keyof Adjustments]))]),
        );
        setEditor({ copiedSectionAdjustments: { section: sectionName, values } });
      };

      const handlePaste = () => {
        if (!copiedSectionAdjustments || copiedSectionAdjustments.section !== sectionName) {
          return;
        }
        setAdjustments((prev) => ({
          ...prev,
          ...copiedSectionAdjustments.values,
          activeTools: setToolActive(getActiveTools(prev), sectionName, true),
        }));
      };

      const handleReset = () => {
        const resetValues = Object.fromEntries(
          sectionKeys.map((key) => [key, JSON.parse(JSON.stringify(INITIAL_ADJUSTMENTS[key as keyof Adjustments]))]),
        );
        setAdjustments((prev) => ({
          ...prev,
          ...resetValues,
          activeTools: setToolActive(getActiveTools(prev), sectionName, true),
        }));
      };

      const isPasteAllowed = Boolean(copiedSectionAdjustments && copiedSectionAdjustments.section === sectionName);
      const translatedSection = t(`editor.adjustments.sections.${sectionName}` as ParseKeys);
      const pasteLabel = copiedSectionAdjustments
        ? t('editor.adjustments.actions.pasteLabel', { section: translatedSection })
        : t('editor.adjustments.actions.pasteSettings');

      const options: Option[] = [
        {
          label: t('editor.adjustments.actions.copySectionSettings', { section: translatedSection }),
          icon: Copy,
          onClick: handleCopy,
        },
        { label: pasteLabel, icon: ClipboardPaste, onClick: handlePaste, disabled: !isPasteAllowed },
        { type: OPTION_SEPARATOR },
        {
          label: t('editor.adjustments.actions.resetSectionSettings', { section: translatedSection }),
          icon: RotateCcw,
          onClick: handleReset,
        },
        { type: OPTION_SEPARATOR },
        {
          label: t('editor.adjustments.actions.customizePanels'),
          icon: LayoutList,
          submenu: [{ customComponent: AdjustmentSectionsSubMenu }],
        },
      ];

      showContextMenu(event.clientX, event.clientY, options);
    },
    [copiedSectionAdjustments, setAdjustments, setEditor, showContextMenu, t],
  );

  return { handleSectionContextMenu, handleToggleVisibility };
}
