'use client';
import type { RefObject } from 'react';
import { Icon, type IconName } from '@/components/ui';
import { useInbox, useResource } from '../data/hooks';
import {
  updateLabel,
  type DesktopUpdateApi,
  type DesktopUpdateStatus,
} from '../data/desktop-update';
import type { LiveSummary } from '../data/sidebar';
import { DesktopUpdateIcon } from '../DesktopUpdate';

/** The same app navigation on every wide work surface and collapsed page. */
export function DesignRail({
  pathname,
  onExpand,
  update,
  hidden,
  onOpenUpdate,
  updatePopoverId,
  updateTriggerRef,
}: {
  pathname: string;
  onExpand: () => void;
  update?: { api?: DesktopUpdateApi; status: DesktopUpdateStatus };
  hidden?: boolean;
  onOpenUpdate: () => void;
  updatePopoverId: string;
  updateTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const packages = useResource<{ served: boolean }>('/api/packages?sidebar=1');
  const inbox = useInbox();
  const live = useResource<{ summary: LiveSummary }>('/api/live', true);
  const user = useResource<{ username: string }>('/api/user');
  const waiting = inbox.items.filter((item) => item.state === 'waiting').length;
  const failing = live.data?.summary.failing ?? 0;
  const place = (href: string, icon: IconName, label: string, mark?: 'dot' | number) => {
    const on = pathname === href || pathname.startsWith(`${href}/`);
    return (
      <a
        href={href}
        className={`dz-rail-item${on ? ' on' : ''}`}
        aria-label={label}
        title={label}
        aria-current={on ? 'page' : undefined}
      >
        <Icon name={icon} size={18} />
        <span className="dz-rail-tip" aria-hidden="true">
          {label}
        </span>
        {mark === 'dot' && <i className="dz-rail-dot" />}
        {typeof mark === 'number' && <span className="dz-rail-count">{mark}</span>}
      </a>
    );
  };
  const name = user.data?.username ?? '';
  return (
    <nav className="dz-rail" aria-label="deploy.local" hidden={hidden}>
      <span className="dz-rail-lights" aria-hidden="true" />
      <a
        href="/dashboard"
        className="dz-rail-item dz-rail-mark"
        aria-label="New task"
        title="New task"
      >
        <span className="dl-mark">d</span>
        <span className="dz-rail-tip" aria-hidden="true">
          New task
        </span>
      </a>
      {place('/dashboard/projects', 'folder', 'Projects')}
      {place(
        '/dashboard/live',
        'pulse',
        failing ? `Live · ${failing} failing` : 'Live',
        failing ? 'dot' : undefined,
      )}
      {place('/dashboard/computers', 'computer', 'Computers')}
      {packages.data?.served && place('/dashboard/packages', 'package', 'Packages')}
      {place('/dashboard/design', 'layers', 'Artifacts')}
      <span className="dz-rail-sep" />
      {place(
        '/dashboard/inbox',
        'attention',
        waiting ? `Waiting on you · ${waiting}` : 'Waiting on you',
        waiting || undefined,
      )}
      <span className="dl-grow" />
      <button
        type="button"
        className="dz-rail-item"
        aria-label="Expand sidebar"
        title="Expand sidebar ⌘\"
        onClick={onExpand}
      >
        <Icon name="sidebar" size={16} />
        <span className="dz-rail-tip" aria-hidden="true">
          Expand sidebar · ⌘\
        </span>
      </button>
      {update?.api && update.status.phase !== 'idle' && (
        <button
          ref={updateTriggerRef}
          type="button"
          className="dz-rail-item dz-rail-update"
          onClick={onOpenUpdate}
          aria-haspopup="dialog"
          aria-expanded={false}
          aria-controls={updatePopoverId}
          aria-label={`deploy.local for Mac · ${updateLabel(update.status)}`}
          title={`deploy.local for Mac · ${updateLabel(update.status)}`}
        >
          <DesktopUpdateIcon status={update.status} rail />
          <span className="dz-rail-tip" aria-hidden="true">
            {updateLabel(update.status)}
          </span>
        </button>
      )}
      <a
        href="/dashboard/settings"
        className="dz-rail-who"
        aria-label={`Settings${name ? ` · ${name}` : ''}`}
        title={`Settings${name ? ` · ${name}` : ''}`}
      >
        {name.slice(0, 1).toUpperCase() || '·'}
        <span className="dz-rail-tip" aria-hidden="true">
          Settings
        </span>
      </a>
    </nav>
  );
}
