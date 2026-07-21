'use client';

import { useEffect, useRef, useState, useId } from 'react';
import { useDialogFocus } from './useDialogFocus';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  /**
   * When set, the confirm button is disabled until the user types this
   * exact string into the inline confirmation input. Use for destructive
   * actions like Recreate / Delete where a fat-fingered click is costly.
   */
  requireTypedConfirmation?: string;
  /** Optional extra content (e.g. checkboxes) rendered below the message. */
  children?: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  requireTypedConfirmation,
  children,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const typedInputRef = useRef<HTMLInputElement>(null);
  const [typed, setTyped] = useState('');
  const titleId = useId();
  const messageId = useId();

  // Reset the typed text every time the dialog opens so a previous open
  // doesn't carry stale value through.
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  useDialogFocus(
    open,
    dialogRef,
    onCancel,
    requireTypedConfirmation ? typedInputRef : confirmRef,
  );

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onCancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={messageId}
        className="relative bg-bg-surface rounded-lg border border-border shadow-xl max-w-sm w-full mx-4 p-6"
      >
        <h3 id={titleId} className="text-sm font-semibold mb-2">
          {title}
        </h3>
        <p id={messageId} className="text-sm text-text-secondary mb-4">{message}</p>
        {children && <div className="mb-4">{children}</div>}
        {requireTypedConfirmation && (
          <div className="mb-5">
            <p className="text-xs text-text-tertiary mb-2">
              Type{' '}
              <code className="font-mono text-text bg-bg-hover px-1.5 py-0.5 rounded">
                {requireTypedConfirmation}
              </code>{' '}
              to confirm.
            </p>
            <input
              ref={typedInputRef}
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="input font-mono"
              autoComplete="off"
              spellCheck={false}
              aria-label="Type confirmation string"
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="btn btn-sm btn-secondary">
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            onClick={onConfirm}
            disabled={requireTypedConfirmation !== undefined && typed !== requireTypedConfirmation}
            className={`btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
