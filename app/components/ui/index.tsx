'use client';

import {
  useId,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type SelectHTMLAttributes,
  type ReactNode,
  type Ref,
} from 'react';

export { LoadingState, ErrorBanner } from '../LoadingState';
export { EmptyState } from '../dashboard/EmptyState';
export { ConfirmDialog } from '../ConfirmDialog';
export { Toggle } from '../Toggle';
export { StatCard } from '../dashboard/StatCard';

/** Native selection, form submission and keyboard behavior with shared trigger and popup tokens. */
export function Select({ className = '', ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`ui-select ${className}`} />;
}

export function Button({
  variant = 'secondary',
  className = '',
  type = 'button',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  ref?: Ref<HTMLButtonElement>;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
}) {
  return (
    <button {...props} type={type} className={`ui-button ui-button-${variant} ${className}`} />
  );
}

/** Use plain inputs inside an existing toolbar or row; retain a real accessible label. */
export function TextField({
  label,
  appearance = 'bordered',
  error,
  id,
  className = '',
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  appearance?: 'bordered' | 'plain';
  error?: string;
}) {
  const generated = useId();
  const inputId = id || generated;
  return (
    <div className={`ui-field ${className}`}>
      <label htmlFor={inputId} className={appearance === 'plain' ? 'sr-only' : 'ui-field-label'}>
        {label}
      </label>
      <input
        {...props}
        id={inputId}
        className="ui-input"
        data-appearance={appearance}
        aria-invalid={error ? true : props['aria-invalid']}
        aria-describedby={
          [props['aria-describedby'], error ? `${inputId}-error` : ''].filter(Boolean).join(' ') ||
          undefined
        }
      />
      {error && (
        <span className="ui-field-error" id={`${inputId}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

export function Metric({
  signal,
  label,
  children,
}: {
  signal: 'cpu' | 'memory' | 'traffic' | 'latency' | 'neutral';
  label: string;
  children: ReactNode;
}) {
  return (
    <span className="ui-metric" data-signal={signal}>
      <span>{label}</span>
      <strong>{children}</strong>
    </span>
  );
}

export { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';

export { StatusBadge, applicationStatusTone, type StatusTone } from './StatusBadge';

export {
  CompactTopBar,
  NoticeRow,
  ResourceRow,
  ContextChip,
  CollapsibleMessage,
  type Notice,
} from './Compact';
