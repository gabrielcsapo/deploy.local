'use client';
import type { ReactNode } from 'react';
import { type ComponentState, Icon, stateProps } from './shared';
export function Item({
  title,
  description,
  lead,
  end,
  href,
  onClick,
  disabled,
  loading,
  children,
}: ComponentState & {
  title: ReactNode;
  description?: ReactNode;
  lead?: ReactNode;
  end?: ReactNode;
  href?: string;
  /** A row that opens something in place, such as a dialog, instead of going to a page. */
  onClick?: () => void;
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
      {(href || onClick) && <Icon name="chevron" className="dl-chev" />}
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
  ) : onClick ? (
    <button
      {...stateProps({ disabled, loading })}
      type="button"
      className="dl-item dl-item-button"
      disabled={disabled || loading}
      onClick={onClick}
    >
      {content}
    </button>
  ) : (
    <div {...stateProps({ disabled, loading })} className="dl-item">
      {content}
    </div>
  );
}
