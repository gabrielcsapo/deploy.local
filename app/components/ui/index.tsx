'use client';

import { WorkspaceIcon } from './WorkspaceIcon';

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
  /** See “Action hierarchy” in docs/design-system.md: one primary per surface, tertiary as `link`. */
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger' | 'link';
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
  appearance?: 'bordered' | 'plain' | 'search';
  error?: string;
}) {
  const generated = useId();
  const inputId = id || generated;
  const input = (
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
  );
  return (
    <div className={`ui-field ${className}`}>
      <label htmlFor={inputId} className={appearance !== 'bordered' ? 'sr-only' : 'ui-field-label'}>
        {label}
      </label>
      {appearance === 'search' ? (
        <div className="ui-search-field">
          <WorkspaceIcon name="search" />
          {input}
        </div>
      ) : (
        input
      )}
      {error && (
        <span className="ui-field-error" id={`${inputId}-error`}>
          {error}
        </span>
      )}
    </div>
  );
}

/** List search has a quiet boundary and an icon; ordinary toolbar entry stays plain. */
export function SearchField({
  placeholder = 'Search…',
  ...props
}: Omit<Parameters<typeof TextField>[0], 'appearance' | 'type'>) {
  return <TextField {...props} placeholder={placeholder} appearance="search" type="search" />;
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

// Pages from before v2 keep their own icon button and skeleton under these names.
export {
  IconButton as LegacyIconButton,
  CopyButton,
  ActionCluster,
  type IconButtonProps,
} from './IconButton';
export { IconLink } from './IconButton';

export { OverflowMenu } from './OverflowMenu';

export { ListPageHeader, ListRow, ListGroup, PropertyRow } from './ListPage';

export { Skeleton as LegacySkeleton } from './Skeleton';

export { TextArea, SegmentedControl } from './FormControls';
// v2 primitives live alongside the existing controls during migration.
export { Sidebar } from './v2/Sidebar';
export { Nav } from './v2/Nav';
export { Head } from './v2/Head';
export { Group } from './v2/Group';
export { Item } from './v2/Item';
export { Setting } from './v2/Setting';
export { Approval } from './v2/Approval';
export { WorkLog } from './v2/WorkLog';
export { Composer } from './v2/Composer';
export { Status } from './v2/Status';
export { Tabs } from './v2/Tabs';
export { Seg } from './v2/Seg';
export { Dialog } from './v2/Dialog';
export { Banner } from './v2/Banner';
export { Empty } from './v2/Empty';
export { Skeleton } from './v2/Skeleton';
export { ChipSelect } from './v2/ChipSelect';
export { Matrix } from './v2/Matrix';
export { Steps } from './v2/Steps';
export { Term } from './v2/Term';
export { Diff } from './v2/Diff';
export { Field } from './v2/Field';
export { Switch } from './v2/Switch';
export { Action, Icon, IconButton, Glyph } from './v2/shared';
export {
  ListTemplate,
  DetailTemplate,
  ConversationTemplate,
  SettingsTemplate,
} from './v2/Templates';
export type { ComponentState, IconName } from './v2/shared';
export type { ApprovalMode } from './v2/Matrix';
export type { DiffLine } from './v2/Diff';
