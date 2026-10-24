'use client';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-flight-router/client';

const reserved = new Set([
  'apps',
  'activity',
  'logs',
  'discover',
  'settings',
  'nodes',
  'computers',
  'catalog',
  'design-system',
  'projects',
  'repositories',
]);
export function SurfaceNavigation({ pathname }: { pathname: string }) {
  const [hash, setHash] = useState('');
  useEffect(() => {
    const update = () => setHash(window.location.hash);
    update();
    window.addEventListener('hashchange', update);
    return () => window.removeEventListener('hashchange', update);
  }, [pathname]);
  const segments = pathname.split('/').filter(Boolean);
  const application = segments[1] && !reserved.has(segments[1]) ? segments[1] : '';
  const title = application
    ? decodeURIComponent(application)
    : {
        apps: 'Applications',
        nodes: 'Computers',
        computers: 'Computers',
        settings: 'Settings',
        'design-system': 'Design system',
        catalog: 'Catalog',
        discover: 'Applications',
        logs: 'Applications',
        activity: 'Applications',
      }[segments[1]] || 'Workspace';
  const items = application
    ? [
        ['Overview', ''],
        ['Deployments', 'releases'],
        ['Logs', 'logs'],
        ['Activity', 'traffic'],
        ['Settings', 'settings'],
      ].map(([label, suffix]) => ({
        label,
        to: `/dashboard/${application}${suffix ? '/' + suffix : ''}`,
      }))
    : segments[1] === 'settings'
      ? [
          ...[
            'Account',
            'Providers',
            'Security',
            'Deployment admission',
            'Backups',
            'Maintenance',
          ].map((label) => ({
            label,
            to: '#settings-' + label.toLowerCase().replaceAll(' ', '-'),
          })),
          { label: 'Design system', to: '/dashboard/design-system' },
        ]
      : segments[1] === 'design-system'
        ? [
            'Foundations',
            'Icons',
            'Components',
            'Motion',
            'Patterns',
            'React and Tailwind',
            'Updating',
          ].map((label) => ({ label, to: '#design-' + label.toLowerCase().replaceAll(' ', '-') }))
        : ['nodes', 'computers'].includes(segments[1])
          ? [
              { label: 'All computers', to: '#computer-list' },
              { label: 'Connect a computer', to: '#computer-enrollment' },
            ]
          : ['apps', 'discover', 'activity', 'logs'].includes(segments[1])
            ? [
                { label: 'All applications', to: '/dashboard/apps' },
                { label: 'Catalog', to: '/dashboard/catalog' },
                { label: 'Shared apps', to: '/dashboard/discover' },
                { label: 'Activity', to: '/dashboard/activity' },
                { label: 'Logs', to: '/dashboard/logs' },
              ]
            : segments[1] === 'catalog'
              ? [
                  { label: 'Browse', to: '/dashboard/catalog' },
                  { label: 'Import Compose', to: '/dashboard/catalog/import' },
                ]
              : [{ label: title, to: pathname }];
  const activeHash =
    ['nodes', 'computers'].includes(segments[1]) &&
    !['#computer-list', '#task-computers', '#computer-enrollment'].includes(hash)
      ? '#computer-list'
      : hash;
  return (
    <aside className="pw-sidebar ds-context-sidebar" aria-label={`${title} navigation`}>
      <header className="ds-context-heading">
        <strong>{title}</strong>
      </header>
      <nav
        className="ds-context-links ui-scroll-strip"
        aria-label={application ? 'Application sections' : `${title} sections`}
      >
        {items.map((item) =>
          item.to.startsWith('#') ? (
            <a
              key={item.to}
              href={item.to}
              aria-current={
                (activeHash ||
                  (segments[1] === 'settings'
                    ? '#settings-account'
                    : segments[1] === 'design-system'
                      ? '#design-foundations'
                      : '#computer-list')) === item.to
                  ? 'page'
                  : undefined
              }
              onClick={() => {
                const target = document.getElementById(item.to.slice(1));
                if (target instanceof HTMLDetailsElement) target.open = true;
                if (document.querySelector('.pw-sidebar[aria-modal="true"]'))
                  window.dispatchEvent(new CustomEvent('deploy:toggle-navigation'));
              }}
            >
              {item.label}
            </a>
          ) : (
            <Link
              key={item.to}
              to={item.to}
              aria-current={
                pathname === item.to ||
                (item.label === 'Browse' &&
                  pathname.startsWith('/dashboard/catalog/') &&
                  !pathname.endsWith('/import'))
                  ? 'page'
                  : undefined
              }
            >
              {item.label}
            </Link>
          ),
        )}
      </nav>
    </aside>
  );
}

/** Pane traversal leaves native editing and scroll keys to the focused control. */
export function useWorkspaceKeyboard() {
  const last = useRef(new Map<Element, HTMLElement>());
  useEffect(() => {
    const scope = () => document.querySelector('.project-workspace');
    const visible = (selector: string) =>
      [...(scope()?.querySelectorAll<HTMLElement>(selector) || [])].find(
        (el) => el.getClientRects().length > 0,
      );
    const panes = () =>
      [
        visible('.workspace-rail,.workspace-tabs,.compact-top-bar'),
        visible(
          '.ds-context-sidebar,.ph-navigation,.pw-sidebar,.phone-task-segments,.phone-section-chips',
        ),
        visible('.ph-work,.pw-surface,.pw-context,.pw-chat'),
      ].filter((el): el is HTMLElement => !!el);
    const focus = (event: FocusEvent) => {
      if (!(event.target instanceof HTMLElement)) return;
      for (const pane of panes()) {
        if (pane.contains(event.target)) {
          last.current.set(pane, event.target);
          break;
        }
      }
    };
    const key = (event: KeyboardEvent) => {
      if (
        document.querySelector(
          'dialog[open],[popover]:popover-open,[role=dialog][aria-modal=true]:not(.pw-sidebar)',
        )
      )
        return;
      const drawer = document.querySelector<HTMLElement>('.pw-sidebar[aria-modal="true"]');
      if (drawer && event.key === 'Escape') {
        event.preventDefault();
        window.dispatchEvent(new CustomEvent('deploy:toggle-navigation'));
        return;
      }
      if (drawer && event.key === 'Tab') {
        const targets = [
          ...drawer.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],select,input'),
        ].filter((el) => el.getClientRects().length);
        const at = targets.indexOf(document.activeElement as HTMLElement);
        if ((event.shiftKey && at <= 0) || (!event.shiftKey && at === targets.length - 1)) {
          event.preventDefault();
          targets[event.shiftKey ? targets.length - 1 : 0]?.focus();
        }
        return;
      }
      if (event.key === 'F6') {
        const all = panes();
        if (!all.length) return;
        event.preventDefault();
        const at = all.findIndex((p) => p.contains(document.activeElement));
        const next = all[(at + (event.shiftKey ? -1 : 1) + all.length) % all.length];
        const saved = last.current.get(next);
        const belongsToPane = (element: HTMLElement) =>
          element.getClientRects().length > 0 &&
          !all.some((pane) => pane !== next && next.contains(pane) && pane.contains(element));
        const target =
          saved?.isConnected && belongsToPane(saved)
            ? saved
            : [
                ...next.querySelectorAll<HTMLElement>(
                  'button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),[tabindex="0"]',
                ),
              ].find(belongsToPane);
        target?.focus({ preventScroll: true });
      }
      if (
        !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) ||
        !(event.target instanceof HTMLElement) ||
        event.target.matches('input,textarea,select,[contenteditable="true"]')
      )
        return;
      const list = event.target.closest(
        '[data-resource-list],.ds-context-links,.workspace-rail,.workspace-tabs,.phone-task-segments,.phone-section-chips',
      );
      if (!list) return;
      if (
        ['ArrowLeft', 'ArrowRight'].includes(event.key) &&
        (!matchMedia('(width < 640px)').matches ||
          !list.matches(
            '.ds-context-links,.workspace-tabs,.phone-task-segments,.phone-section-chips',
          ))
      )
        return;
      const rows = [
        ...list.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],summary'),
      ].filter((el) => el.getClientRects().length > 0 && !el.closest('[inert]'));
      const at = rows.indexOf(event.target);
      if (at < 0) return;
      event.preventDefault();
      rows[
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? rows.length - 1
            : Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  at + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1),
                ),
              )
      ]?.focus();
    };
    document.addEventListener('focusin', focus);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('focusin', focus);
      document.removeEventListener('keydown', key);
    };
  }, []);
}
