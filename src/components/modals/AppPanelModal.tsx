import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Panel } from '../ui/AppProperties';

interface AppPanelModalProps {
  panel: Panel.Metadata | Panel.Export | null;
  onClose: () => void;
  renderPanel: (panel: Panel, asModal?: boolean) => ReactNode;
}

export default function AppPanelModal({ panel, onClose, renderPanel }: AppPanelModalProps) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropPointerRef = useRef<number | null>(null);
  const isOpen = panel !== null;

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      backdropPointerRef.current = null;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const targetDialog = event.target instanceof Element ? event.target.closest('[aria-modal="true"]') : null;
      // Leave any nested dialog's keyboard handling to that dialog.
      if (targetDialog && targetDialog !== dialog) return;

      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        onClose();
      } else if (event.key === 'Tab') {
        const focusable = Array.from(
          dialog.querySelectorAll<HTMLElement>(
            'button, a[href], input, select, textarea, [tabindex], [contenteditable="true"]',
          ),
        ).filter(
          (element) =>
            element.tabIndex >= 0 &&
            !element.matches(':disabled') &&
            !element.closest('[inert]') &&
            element.getClientRects().length > 0,
        );
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (!first || !last) {
          event.preventDefault();
          dialog.focus();
        } else if (event.shiftKey && (active === first || !dialog.contains(active))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (panel === null || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-xs p-4"
      onPointerDownCapture={(event) => {
        backdropPointerRef.current =
          event.target === event.currentTarget && event.button === 0 ? event.pointerId : null;
      }}
      onPointerUp={(event) => {
        const shouldClose =
          backdropPointerRef.current === event.pointerId &&
          event.target === event.currentTarget &&
          document.elementFromPoint(event.clientX, event.clientY) === event.currentTarget;
        backdropPointerRef.current = null;
        if (shouldClose) onClose();
      }}
      onPointerCancel={() => {
        backdropPointerRef.current = null;
      }}
    >
      <div
        aria-label={panel === Panel.Export ? t('export.title') : t('editor.metadata.title')}
        aria-modal="true"
        data-app-panel-modal
        className="relative flex min-h-0 max-h-[80vh] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-lg bg-surface text-text-primary shadow-xl"
        ref={dialogRef}
        role="dialog"
        style={{ width: panel === Panel.Export ? 560 : 480 }}
        tabIndex={-1}
      >
        <button
          aria-label={t('modals.culling.close')}
          className="absolute right-2 top-2 z-10 rounded-md bg-surface p-1.5 text-text-secondary hover:bg-card-active hover:text-text-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
          onClick={onClose}
          ref={closeRef}
          type="button"
        >
          <X aria-hidden="true" size={18} />
        </button>
        <div className="flex min-h-0 flex-col overflow-y-auto [&>*]:min-h-0">{renderPanel(panel, true)}</div>
      </div>
    </div>,
    document.body,
  );
}
