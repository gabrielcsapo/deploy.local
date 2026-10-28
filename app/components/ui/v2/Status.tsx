'use client';
import type { ReactNode } from 'react';
import { Icon, type ComponentState, stateProps } from './shared';
export function Status({
  children,
  kind = 'healthy',
  disabled,
  loading,
}: ComponentState & {
  children: ReactNode;
  kind?:
    | 'healthy'
    | 'active'
    | 'attention'
    | 'failed'
    | 'inactive'
    | 'running'
    | 'ready'
    | 'waiting';
}) {
  const glyph =
    loading || kind === 'running'
      ? 'running'
      : kind === 'ready'
        ? 'check'
        : kind === 'waiting'
          ? 'attention'
          : null;
  return (
    <span {...stateProps({ disabled, loading })} className={`dl-status ${kind}`} role="status">
      {glyph ? (
        <Icon
          name={glyph}
          size={14}
          className={
            glyph === 'running' ? 'dl-run dl-spin' : glyph === 'check' ? 'dl-ok' : 'dl-attn'
          }
        />
      ) : (
        <span className="dl-dot" />
      )}
      {children}
    </span>
  );
}
