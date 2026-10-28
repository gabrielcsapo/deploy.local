'use client';
import type { ReactNode } from 'react';
import { type ComponentProps, stateProps } from './shared';
export function Sidebar({
  children,
  brand,
  navigation,
  footer,
  className = '',
  disabled,
  loading,
  ...props
}: ComponentProps & { brand?: ReactNode; navigation?: ReactNode; footer?: ReactNode }) {
  return (
    <aside
      {...props}
      {...stateProps({ disabled, loading })}
      className={`dl-side ${className}`}
      aria-label={props['aria-label'] || 'deploy.local'}
    >
      <div className="dl-side-top">{brand}</div>
      <nav className="dl-side-nav" aria-label="Main navigation">
        {navigation}
      </nav>
      <div className="dl-side-scroll">{children}</div>
      {footer}
    </aside>
  );
}
