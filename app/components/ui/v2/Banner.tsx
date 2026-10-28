'use client';
import type { ReactNode } from 'react';
import { type ComponentState, type IconName, Icon, stateProps } from './shared';
export function Banner({
  title,
  children,
  action,
  kind = 'warning',
  icon,
  disabled,
  loading,
}: ComponentState & {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  kind?: 'warning' | 'danger' | 'neutral';
  icon?: IconName;
}) {
  return (
    <div
      className={`dl-banner ${kind}`}
      role={kind === 'danger' ? 'alert' : 'status'}
      {...stateProps({ disabled, loading })}
    >
      <Icon name={icon || (kind === 'danger' ? 'close' : 'cloud')} />
      <span className="dl-t">
        <span>{title}</span>
        {children && <span>{children}</span>}
      </span>
      {action && <span className="dl-end">{action}</span>}
    </div>
  );
}
