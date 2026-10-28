'use client';
import type { ReactNode } from 'react';
import { type ComponentState, stateProps } from './shared';
export function Setting({
  label,
  description,
  children,
  disabled,
  loading,
}: ComponentState & { label: ReactNode; description?: ReactNode; children: ReactNode }) {
  return (
    <div {...stateProps({ disabled, loading })} className="dl-setting">
      <div className="dl-t">
        <span>{label}</span>
        {description && <span>{description}</span>}
      </div>
      <div className="dl-v">{children}</div>
    </div>
  );
}
