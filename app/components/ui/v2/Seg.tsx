'use client';
import { type ComponentState, stateProps } from './shared';
export function Seg({
  options,
  value,
  onChange,
  label,
  disabled,
  loading,
}: ComponentState & {
  options: { label: string; value: string; disabled?: boolean }[];
  value: string;
  onChange: (value: string) => void;
  label: string;
}) {
  return (
    <div className="dl-seg" role="group" aria-label={label} {...stateProps({ disabled, loading })}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          disabled={disabled || loading || option.disabled}
          className={value === option.value ? 'on' : ''}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
