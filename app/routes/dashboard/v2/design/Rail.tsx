'use client';
import { Icon, type IconName } from '@/components/ui';
import { useInbox, useResource } from '../data/hooks';
import type { LiveSummary } from '../data/sidebar';

/** The same app navigation on every wide work surface and collapsed page. */
export function DesignRail({ pathname, onExpand }: { pathname: string; onExpand: () => void }) {
  const inbox = useInbox();
  const live = useResource<{ summary: LiveSummary }>('/api/v2/live', true);
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
        {mark === 'dot' && <i className="dz-rail-dot" />}
        {typeof mark === 'number' && <span className="dz-rail-count">{mark}</span>}
      </a>
    );
  };
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
      {place('/dashboard/design', 'layers', 'Design')}
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
      </button>
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
