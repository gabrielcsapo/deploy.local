'use client';
import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { type ComponentState, stateProps } from './shared';
export function Nav({
  children,
  lead,
  end,
  active,
  strong,
  disabled,
  loading,
  className = '',
  href,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> &
  ComponentState & { lead?: ReactNode; end?: ReactNode; active?: boolean; strong?: boolean }) {
  return (
    <a
      {...props}
      {...stateProps({ disabled, loading })}
      href={disabled || loading ? undefined : href}
      aria-current={active ? 'page' : undefined}
      className={`dl-nav ${active ? 'on' : ''} ${strong ? 'strong' : ''} ${className}`}
    >
      {lead && <span className="dl-lead">{lead}</span>}
      <span className="dl-t">{children}</span>
      {end && <span className="dl-end">{end}</span>}
    </a>
  );
}
