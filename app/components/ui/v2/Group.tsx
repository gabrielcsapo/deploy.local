'use client';
import type { ReactNode } from 'react';
import { type ComponentProps, stateProps } from './shared';
export function Group({
  title,
  end,
  children,
  disabled,
  loading,
  className = '',
  ...props
}: Omit<ComponentProps, 'title'> & { title?: ReactNode; end?: ReactNode }) {
  return (
    <section {...props} {...stateProps({ disabled, loading })} className={`dl-group ${className}`}>
      {title && (
        <div className="dl-group-head">
          {title}
          <span className="dl-end">{end}</span>
        </div>
      )}
      {children}
    </section>
  );
}
