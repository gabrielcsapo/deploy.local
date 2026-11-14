'use client';
import { useLocation } from 'react-flight-router/client';
import { openSearch } from './v2/search/model.ts';
import { Action, Empty, Glyph, Head, IconButton } from '@/components/ui';

export function pageTitle(pathname: string) {
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [, place, resource, section, app, appSection] = segments;
  const names: Record<string, string> = {
    inbox: 'Waiting on you',
    live: 'Live',
    projects: 'Projects',
    computers: 'Computers',
    models: 'Models',
    add: 'Add a computer',
    agents: 'Agents',
    new: 'New agent',
    settings: 'Settings',
    approvals: 'Approvals',
    backups: 'Backups',
    discover: 'Discover',
    code: 'Code',
    pulls: 'Pull requests',
    issues: 'Issues',
    releases: 'Releases',
    logs: 'Logs',
    changes: 'Changes',
    checks: 'Checks',
    tune: 'Tune',
    import: 'Import an app',
  };
  if (place === 'projects' && section === 'apps')
    return appSection === 'settings' ? `${app} · Settings` : app;
  if (place === 'projects' && section === 'releases' && app) return `Release ${app}`;
  if (place === 'tasks') return section ? names[section] || section : 'Task';
  if (place === 'agents' && resource && resource !== 'new')
    return `${resource.charAt(0).toUpperCase()}${resource.slice(1)}${section === 'tune' ? ' · Tune' : ''}`;
  return names[section] || names[resource] || resource || names[place] || 'Home';
}
export default function Placeholder() {
  const { pathname } = useLocation();
  const [, place, resource, section, app] = pathname
    .split('/')
    .filter(Boolean)
    .map(decodeURIComponent);
  let title = pageTitle(pathname);
  let subtitle: string | undefined;
  let actions = <IconButton icon="search" label="Search" onClick={() => openSearch()} />;
  if (place === 'settings') {
    title = 'Settings';
    actions = <></>;
  }
  if (place === 'projects' && resource) {
    title = section === 'apps' ? app : resource;
    subtitle = section === 'apps' ? `App in ${resource}` : 'Project';
    actions = (
      <>
        <a className="dl-btn secondary" href="/dashboard">
          New task
        </a>
        <IconButton icon="search" label="Search" onClick={() => openSearch()} />
      </>
    );
  }
  if (place === 'tasks') {
    title = resource === 'self-release' ? 'Self-release pipeline' : resource;
    if (resource === 'self-release') subtitle = 'deploy.local · MacBook Pro';
    actions = <IconButton icon="computer" label="Computer use (coming soon)" disabled />;
  }
  if (place === 'computers') {
    if (resource === 'add') title = 'Computers';
    else if (resource && resource !== 'models') {
      title = resource;
      subtitle = 'Computer';
      actions = <IconButton icon="terminal" label="Terminal (coming soon)" disabled />;
    }
  }
  if (place === 'agents') {
    actions =
      section === 'tune' ? (
        <Action variant="primary" disabled>
          Save
        </Action>
      ) : (
        <IconButton icon="panel" label="Tracking (coming soon)" disabled />
      );
    if (resource === 'new')
      actions = (
        <a className="dl-icon-btn" href="/dashboard" aria-label="Close">
          ×
        </a>
      );
    if (resource === 'scout' && !section) subtitle = 'Keeps deploy.local moving';
  }
  if (place === 'discover') {
    title = 'Discover';
    subtitle = resource;
  }
  if (place === 'live' && resource) subtitle = 'Live';
  return (
    <>
      <Head
        title={
          place === 'agents' && resource !== 'new' ? (
            <span className="dl-who-line">
              <Glyph kind={resource === 'warden' ? 'warden' : ''}>
                {resource?.charAt(0).toUpperCase()}
              </Glyph>
              {title}
            </span>
          ) : (
            title
          )
        }
        subtitle={subtitle}
        actions={actions}
        ruled
        menu={
          <IconButton
            icon="menu"
            label="Show sidebar"
            className="dl-menu-btn"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
      />
      <div className="dl-scroll dl-placeholder">
        <Empty title="This screen is coming." icon="folder">
          {pageTitle(pathname)} will be available in a coming update.
        </Empty>
      </div>
      <span className="dl-fixture-note">Design preview · sample data</span>
    </>
  );
}
