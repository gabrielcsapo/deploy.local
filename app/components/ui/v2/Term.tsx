'use client';
import type { HTMLAttributes } from 'react';
import { type ComponentState, stateProps } from './shared';
export function Term({
  children,
  disabled,
  loading,
  className = '',
  ...props
}: HTMLAttributes<HTMLPreElement> & ComponentState) {
  return (
    <pre
      {...props}
      {...stateProps({ disabled, loading })}
      tabIndex={disabled ? undefined : 0}
      className={`dl-term ${className}`}
    >
      <code>{children}</code>
    </pre>
  );
}
