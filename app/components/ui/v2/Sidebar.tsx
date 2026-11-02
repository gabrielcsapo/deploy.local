'use client';
import type { ReactNode } from 'react';
import { Icon, type ComponentProps, stateProps } from './shared';
export function Sidebar({
  children,
  brand,
  navigation,
  footer,
  onCollapse,
  className = '',
  disabled,
  loading,
  ...props
}: ComponentProps & {
  brand?: ReactNode;
  navigation?: ReactNode;
  footer?: ReactNode;
  onCollapse?: () => void;
}) {
  return (
    <aside
      {...props}
      {...stateProps({ disabled, loading })}
      className={`dl-side ${className}`}
      aria-label={props['aria-label'] || 'deploy.local'}
    >
      <div className="dl-side-top">
        {brand}
        {onCollapse && (
          <button
            type="button"
            className="dl-icon-btn"
            aria-label="Collapse sidebar"
            title="Collapse sidebar ⌘\"
            onClick={onCollapse}
          >
            <Icon name="sidebar" />
          </button>
        )}
      </div>
      <nav className="dl-side-nav" aria-label="Main navigation">
        {navigation}
      </nav>
      <div className="dl-side-scroll">{children}</div>
      {footer}
    </aside>
  );
}
