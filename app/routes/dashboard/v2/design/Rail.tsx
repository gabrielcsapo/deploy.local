'use client';
import { Icon, type IconName } from '@/components/ui';
import { useInbox, useResource } from '../data/hooks';
import type { LiveSummary } from '../data/sidebar';

/**
 * The app's places beside the Design page, as icons: the page is a place in the app, not a mode
 * to leave. The Mac app's window buttons sit on its top row.
 */
export function DesignRail() {
  const inbox = useInbox();
  const live = useResource<{ summary: LiveSummary }>('/api/v2/live', true);
  const user = useResource<{ username: string }>('/api/user');
  const waiting = inbox.items.filter((item) => item.state === 'waiting').length;
  const failing = live.data?.summary.failing ?? 0;
  const place = (
    href: string,
    icon: IconName,
    label: string,
    mark?: 'dot' | number,
    on = false,
  ) => (
    <a
      href={href}
      className={`dz-rail-item${on ? ' on' : ''}`}
      aria-label={label}
      title={label}
      aria-current={on ? 'page' : undefined}
    >
      <Icon name={icon} size={18} />
      {mark === 'dot' && <i className="dz-rail-dot" />}
      {typeof mark === 'number' && <span className="dz-rail-count">{mark}</span>}
    </a>
  );
  const name = user.data?.username ?? '';
  return (
    <nav className="dz-rail" aria-label="deploy.local">
      <span className="dz-rail-lights" aria-hidden="true" />
      <a
        href="/dashboard"
        className="dz-rail-item dz-rail-mark"
        aria-label="New task"
        title="New task"
      >
        <span className="dl-mark">d</span>
      </a>
      {place('/dashboard/projects', 'folder', 'Projects')}
      {place(
        '/dashboard/live',
        'pulse',
        failing ? `Live · ${failing} failing` : 'Live',
        failing ? 'dot' : undefined,
      )}
      {place('/dashboard/computers', 'computer', 'Computers')}
      {place('/dashboard/design', 'layers', 'Design', undefined, true)}
      <span className="dz-rail-sep" />
      {place(
        '/dashboard/inbox',
        'attention',
        waiting ? `Waiting on you · ${waiting}` : 'Waiting on you',
        waiting || undefined,
      )}
      <span className="dl-grow" />
      <a
        href="/dashboard/settings"
        className="dz-rail-who"
        aria-label={`Settings${name ? ` · ${name}` : ''}`}
        title={`Settings${name ? ` · ${name}` : ''}`}
      >
        {name.slice(0, 1).toUpperCase() || '·'}
      </a>
    </nav>
  );
}
