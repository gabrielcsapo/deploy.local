'use client';
import type { ReactNode } from 'react';
import { type ComponentProps, type IconName, Icon, stateProps } from './shared';
export function Empty({
  title,
  children,
  actions,
  icon,
  disabled,
  loading,
  className = '',
  ...props
}: ComponentProps & { title: string; actions?: ReactNode; icon?: IconName }) {
  return (
    <div {...props} className={`dl-empty ${className}`} {...stateProps({ disabled, loading })}>
      {icon && (
        <span className="dl-glyph">
          <Icon name={icon} size={20} />
        </span>
      )}
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {actions && <div className="dl-actions">{actions}</div>}
    </div>
  );
}
