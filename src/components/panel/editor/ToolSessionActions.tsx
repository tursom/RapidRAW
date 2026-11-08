import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import Button from '../../ui/Button';
import { Panel } from '../../ui/AppProperties';
import { useEditorStore } from '../../../store/useEditorStore';
import { useProcessStore } from '../../../store/useProcessStore';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { useUIStore } from '../../../store/useUIStore';
import { applyToolSession, cancelToolSession, toolSessionBusy } from '../../../hooks/useEditorActions';

export default function ToolSessionActions() {
  const { t } = useTranslation();
  const osPlatform = useSettingsStore((state) => state.osPlatform);
  const activePanel = useUIStore((state) => state.activePanel);
  const editor = useEditorStore(
    useShallow((state) => ({
      selectedImage: state.selectedImage,
      isGeneratingAi: state.isGeneratingAi,
      isGeneratingAiMask: state.isGeneratingAiMask,
      adjustments: state.adjustments,
    })),
  );
  const activeAiTasks = useProcessStore((state) => state.activeAiTasks);

  if (
    osPlatform === 'android' ||
    !editor.selectedImage ||
    (activePanel !== Panel.Crop && activePanel !== Panel.Masks && activePanel !== Panel.Ai)
  )
    return null;

  const disabled = !editor.selectedImage.isReady || toolSessionBusy(editor, { activeAiTasks });

  return (
    <div data-tool-session-actions className="relative z-10 shrink-0 flex justify-center gap-3 py-2">
      <Button type="button" data-tool-session-action="apply" disabled={disabled} onClick={applyToolSession}>
        {t('modals.transform.apply')}
      </Button>
      <Button
        type="button"
        data-tool-session-action="cancel"
        className="bg-surface text-text-primary"
        disabled={disabled}
        onClick={cancelToolSession}
      >
        {t('modals.transform.cancel')}
      </Button>
    </div>
  );
}
