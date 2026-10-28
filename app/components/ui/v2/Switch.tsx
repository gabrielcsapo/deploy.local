'use client';
import type { ComponentState } from './shared';
export function Switch({
  label,
  checked,
  onChange,
  disabled,
  loading,
}: ComponentState & { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <button
      type="button"
      className={`dl-switch ${checked ? '' : 'off'}`}
      role="switch"
      aria-label={label}
      aria-checked={checked}
      aria-busy={loading || undefined}
      disabled={disabled || loading}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
