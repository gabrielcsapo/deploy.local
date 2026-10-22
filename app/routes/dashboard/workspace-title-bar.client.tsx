'use client';
import type { ReactNode } from 'react';
import { Link } from 'react-flight-router/client';
import { ActionCluster, IconButton, WorkspaceIcon } from '@/components/ui';

export function WorkspaceTitleBar({
  title,
  navigation,
  icon = 'folder',
  prefix,
  status,
  actions,
  className = '',
  tooltip,
  toggleNavigation,
  compact = false,
  back,
  onBack,
  onBackLabel = 'Back',
  profile = false,
}: {
  compact?: boolean;
  back?: string;
  onBack?: () => void;
  onBackLabel?: string;
  profile?: boolean;
  navigation?: ReactNode;
  title: string;
  icon?: string;
  prefix?: { title: string; href: string };
  status?: ReactNode;
  actions?: ReactNode;
  className?: string;
  tooltip?: string;
  toggleNavigation?: () => void;
}) {
  return (
    <header
      className={`pw-header workspace-title-bar ${compact ? 'compact-top-bar phone-only' : ''} ${className}`}
      data-single-row={compact || undefined}
    >
      {compact && onBack ? (
        <IconButton icon="back" label={onBackLabel} onClick={onBack} />
      ) : compact && back ? (
        <Link to={back} className="ui-icon-button" aria-label="Back">
          <WorkspaceIcon name="back" />
        </Link>
      ) : (
        <IconButton
          icon="navigation"
          label="Show sidebar"
          className="pw-mobile-menu"
          onClick={
            toggleNavigation ??
            (() => window.dispatchEvent(new CustomEvent('deploy:toggle-navigation')))
          }
        />
      )}
      {navigation}
      <span className="pw-title-project">
        <WorkspaceIcon name={icon} />
      </span>
      <div className="pw-heading">
        {prefix && (
          <>
            <Link className="workspace-title-prefix" to={prefix.href}>
              {prefix.title}
            </Link>
            <span aria-hidden="true"> / </span>
          </>
        )}
        <strong title={tooltip}>{title}</strong>
      </div>
      {status && <span className="pw-header-status">{status}</span>}
      <ActionCluster>
        {compact && profile && !onBack && (
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
        {actions}
        <IconButton
          icon="search"
          label="Search commands"
          onClick={() => window.dispatchEvent(new CustomEvent('deploy:command-palette'))}
        />
      </ActionCluster>
    </header>
  );
}

export function dashboardSection(pathname: string) {
  const section = pathname.split('/')[2] || 'projects';
  const sections: Record<string, [string, string]> = {
    projects: ['New task', 'folder'],
    repositories: ['Repositories', 'folder'],
    apps: ['Applications', 'grid'],
    nodes: ['Computers', 'computer'],
    computers: ['Computers', 'computer'],
    settings: ['Settings', 'settings'],
    'design-system': ['Design system', 'grid'],
    activity: ['Activity', 'terminal'],
    logs: ['Logs', 'terminal'],
    catalog: ['Catalog', 'grid'],
    discover: ['Shared apps', 'grid'],
  };
  const [title, icon] = sections[section] ?? ['Applications', 'grid'];
  return { title, icon };
}
