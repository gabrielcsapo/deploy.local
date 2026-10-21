'use client';
import { IconButton } from './IconButton';

import { useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-flight-router/client';
import { Button } from './index';
import { StatusBadge, type StatusTone } from './StatusBadge';
import { WorkspaceIcon } from './WorkspaceIcon';

/** Phone-only location chrome. Context gets its own line; the title truncates without losing its accessible text. */
export function CompactTopBar({
  title,
  context,
  back,
  onBack,
  onBackLabel = 'Back to tasks',
  action,
  profile = false,
}: {
  title: string;
  context?: ReactNode;
  back?: string;
  onBack?: () => void;
  onBackLabel?: string;
  action?: ReactNode;
  profile?: boolean;
}) {
  return (
    <header className="compact-top-bar phone-only">
      <div className="compact-top-actions">
        {back ? (
          <Link
            to={back}
            className="ui-icon-button"
            data-size="touch"
            aria-label="Back"
            title="Back"
          >
            <WorkspaceIcon name="back" />
          </Link>
        ) : onBack ? (
          <IconButton icon="back" label={onBackLabel} onClick={onBack} />
        ) : null}
        {profile && (
          <IconButton
            icon="user"
            label="Account and settings"
            onClick={(event) =>
              window.dispatchEvent(
                new CustomEvent('deploy:account', { detail: event.currentTarget }),
              )
            }
          />
        )}
        <span />
        <IconButton
          icon="search"
          label="Search workspace"
          onClick={() => window.dispatchEvent(new CustomEvent('deploy:command-palette'))}
        />
        {action}
      </div>
      <strong className="compact-title" title={title}>
        {title}
      </strong>
      {context && <div className="compact-context">{context}</div>}
    </header>
  );
}

export type Notice = { id: string; tone: StatusTone; content: ReactNode };
export function NoticeRow({ notices }: { notices: Notice[] }) {
  if (!notices.length) return null;
  const severity: StatusTone[] = ['failed', 'attention', 'active', 'inactive', 'healthy'];
  const tone = severity.find((candidate) => notices.some((notice) => notice.tone === candidate))!;
  return (
    <details className="notice-row phone-only">
      <summary>
        <StatusBadge
          tone={tone}
          label={`${notices.length} ${notices.length === 1 ? 'notice' : 'notices'}`}
        />
        <WorkspaceIcon name="chevron-down" />
      </summary>
      <div>
        {notices.map((notice) => (
          <div key={notice.id} className="notice-content">
            {notice.content}
          </div>
        ))}
      </div>
    </details>
  );
}

/** One real destination per resource, with optional adjacent editing controls. */
export function ResourceRow({
  to,
  name,
  secondary,
  status,
  summary,
  onClick,
  current,
}: {
  to: string;
  name: string;
  secondary?: ReactNode;
  status: ReactNode;
  summary: ReactNode;
  onClick?: () => void;
  current?: boolean;
}) {
  return (
    <Link
      to={to}
      className="resource-row"
      aria-current={current ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="resource-identity">
        <strong>{name}</strong>
        {secondary && <span>{secondary}</span>}
      </span>
      {status}
      <span className="resource-summary">{summary}</span>
      <WorkspaceIcon name="chevron" />
    </Link>
  );
}

/** A real popover picker, without a truncated native select underneath. */
export function ContextChip({
  label,
  value,
  options,
  onChange,
  disabled = false,
  tone = 'inactive',
}: {
  label: string;
  value: string;
  options: { value: string; label: string; tone?: StatusTone }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  tone?: StatusTone;
}) {
  const id = useId();
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <div className="context-chip">
      <Button
        ref={trigger}
        variant="quiet"
        disabled={disabled}
        popoverTarget={id}
        aria-label={`${label}: ${options.find((option) => option.value === value)?.label || value || 'None'}`}
      >
        <StatusBadge
          tone={tone}
          label={options.find((option) => option.value === value)?.label || value || 'None'}
        />
        <WorkspaceIcon name="chevron-down" />
      </Button>
      <div
        id={id}
        ref={popup}
        popover="auto"
        className="context-chip-popover"
        role="dialog"
        aria-label={label}
        onToggle={(event) => {
          if (event.newState === 'open')
            popup.current
              ?.querySelector<HTMLButtonElement>('[aria-pressed="true"],button')
              ?.focus();
        }}
      >
        <strong>{label}</strong>
        {options.map((option) => (
          <Button
            key={option.value}
            variant="quiet"
            aria-pressed={value === option.value}
            onClick={() => {
              onChange(option.value);
              popup.current?.hidePopover();
              trigger.current?.focus();
            }}
          >
            <StatusBadge tone={option.tone || 'inactive'} label={option.label} />
            {value === option.value && <WorkspaceIcon name="check" />}
          </Button>
        ))}
      </div>
    </div>
  );
}

export function CollapsibleMessage({ children }: { children: ReactNode }) {
  const body = useRef<HTMLDivElement>(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const id = useId();
  useLayoutEffect(() => {
    const element = body.current;
    if (!element) return;
    const measure = () =>
      setLong(element.scrollHeight > parseFloat(getComputedStyle(element).lineHeight) * 6 + 1);
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [children]);
  return (
    <div className="collapsible-message" data-expanded={expanded || !long}>
      <div
        id={id}
        ref={body}
        className="collapsible-message-body"
        onFocusCapture={() => setExpanded(true)}
      >
        {children}
      </div>
      {long && (
        <div className="phone-only">
          <IconButton
            icon={expanded ? 'chevron-up' : 'chevron-down'}
            label={expanded ? 'Show less' : 'Show more'}
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded(!expanded)}
          />
        </div>
      )}
    </div>
  );
}
