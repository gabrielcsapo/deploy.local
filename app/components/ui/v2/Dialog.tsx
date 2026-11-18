'use client';
import { createPortal } from 'react-dom';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { type ComponentState, IconButton } from './shared';
export function Dialog({
  open,
  onClose,
  title,
  meta,
  children,
  actions,
  disabled,
  loading,
  className = '',
}: ComponentState & {
  open: boolean;
  onClose: () => void;
  title: string;
  /** A line under the title, such as who wrote it and when. */
  meta?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement;
    if (open && !dialog.open) {
      dialog.showModal();
      const target =
        dialog.querySelector<HTMLElement>('[data-dialog-focus]') ??
        dialog.querySelector<HTMLElement>(
          '.dl-dialog-body :is(input, textarea, select, button, a[href]):not(:disabled)',
        ) ??
        dialog.querySelector<HTMLElement>('.dl-dialog-foot button:not(:disabled)');
      target?.focus();
    } else if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open, mounted]);
  if (!mounted) return null;
  return createPortal(
    <dialog
      ref={ref}
      className={`dl-dialog dl-modal ${className}`}
      aria-labelledby={id}
      aria-busy={loading || undefined}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const rect = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
          )
            onClose();
        }
      }}
    >
      <div className="dl-dialog-head">
        {meta ? (
          <div className="dl-dialog-title">
            <h2 id={id} className="dl-section-title">
              {title}
            </h2>
            <span className="dl-meta">{meta}</span>
          </div>
        ) : (
          <h2 id={id} className="dl-section-title">
            {title}
          </h2>
        )}
        <IconButton icon="close" label="Close dialog" onClick={onClose} />
      </div>
      <div className="dl-dialog-body" inert={disabled || loading || undefined}>
        {children}
      </div>
      <div className="dl-dialog-foot" inert={disabled || loading || undefined}>
        {actions}
      </div>
    </dialog>,
    document.body,
  );
}
