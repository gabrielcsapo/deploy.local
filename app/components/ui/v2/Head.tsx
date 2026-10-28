'use client';
import type { ReactNode } from 'react';
import { type ComponentProps, stateProps } from './shared';
export function Head({
  title,
  subtitle,
  actions,
  menu,
  ruled,
  disabled,
  loading,
  className = '',
  ...props
}: Omit<ComponentProps, 'title'> & {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  menu?: ReactNode;
  ruled?: boolean;
}) {
  return (
    <header
      {...props}
      {...stateProps({ disabled, loading })}
      className={`dl-head ${ruled ? 'ruled' : ''} ${className}`}
    >
      {menu}
      <span className="dl-t">{title}</span>
      {subtitle && <span className="dl-sub">{subtitle}</span>}
      <span className="dl-end">{actions}</span>
    </header>
  );
}
