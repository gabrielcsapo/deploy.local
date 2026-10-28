'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { type ComponentState, IconButton } from './shared';
export function Dialog({
  open,
  onClose,
  title,
  children,
  actions,
  disabled,
  loading,
  className = '',
}: ComponentState & {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const previous = document.activeElement;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    return () => {
      if (dialog.open) dialog.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dl-dialog ${className}`}
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
        <h2 id={id} className="dl-section-title">
          {title}
        </h2>
        <IconButton icon="close" label="Close dialog" onClick={onClose} />
      </div>
      <div className="dl-dialog-body" inert={disabled || loading || undefined}>
        {children}
      </div>
      <div className="dl-dialog-foot" inert={disabled || loading || undefined}>
        {actions}
      </div>
    </dialog>
  );
}
