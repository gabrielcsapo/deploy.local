'use client';
import type { ReactNode } from 'react';
import { type ComponentState, Icon, stateProps } from './shared';
export function Item({
  title,
  description,
  lead,
  end,
  href,
  disabled,
  loading,
  children,
}: ComponentState & {
  title: ReactNode;
  description?: ReactNode;
  lead?: ReactNode;
  end?: ReactNode;
  href?: string;
  children?: ReactNode;
}) {
  const content = (
    <>
      {lead}
      <span className="dl-t">
        <span>{title}</span>
        {description && <span>{description}</span>}
      </span>
      {end && <span className="dl-c">{end}</span>}
      {children}
      {href && <Icon name="chevron" className="dl-chev" />}
    </>
  );
  return href ? (
    <a
      {...stateProps({ disabled, loading })}
      className="dl-item"
      href={disabled || loading ? undefined : href}
    >
      {content}
    </a>
  ) : (
    <div {...stateProps({ disabled, loading })} className="dl-item">
      {content}
    </div>
  );
}
