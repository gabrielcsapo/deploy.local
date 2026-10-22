'use client';
import type { ReactNode } from 'react';
import { Link } from 'react-flight-router/client';
import { WorkspaceIcon, type WorkspaceIconName } from './WorkspaceIcon';
import { ActionCluster } from './IconButton';
import { OverflowMenu } from './OverflowMenu';

export function ListPageHeader({ children }: { children: ReactNode }) {
  return <header className="ui-list-header">{children}</header>;
}

/** The navigation link and utilities are siblings: no buttons nested inside links. */
export function ListRow({
  to,
  icon,
  title,
  secondary,
  status,
  badge,
  actions,
  menu,
  selection,
}: {
  to: string;
  icon: WorkspaceIconName;
  title: string;
  secondary: ReactNode;
  status?: ReactNode;
  badge?: ReactNode;
  actions?: ReactNode;
  menu?: ReactNode;
  selection?: ReactNode;
}) {
  return (
    <div className="ui-list-row">
      {selection && <div className="ui-list-selection">{selection}</div>}
      <Link to={to} className="ui-list-link">
        <WorkspaceIcon name={icon} />
        <span className="ui-list-copy">
          <span className="ui-list-title">
            {title} {badge}
          </span>
          <span className="ui-list-secondary">{secondary}</span>
        </span>
        {status && <span className="ui-list-status">{status}</span>}
      </Link>
      {(actions || menu) && (
        <ActionCluster className="ui-list-actions">
          {actions}
          {menu && <OverflowMenu label={`Actions for ${title}`}>{menu}</OverflowMenu>}
        </ActionCluster>
      )}
    </div>
  );
}

export function ListGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ui-list-group" aria-label={title}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function PropertyRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="ui-property-row">
      <div className="ui-property-label">{label}</div>
      <div className="ui-property-value">{children}</div>
    </div>
  );
}
