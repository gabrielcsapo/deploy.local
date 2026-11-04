'use client';
import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import type { ComponentState } from './shared';
export function Field({
  label,
  error,
  id,
  disabled,
  loading,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & ComponentState & { label: ReactNode; error?: string }) {
  const generated = useId();
  const inputId = id || generated;
  return (
    <div>
      <label className="dl-field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className={`dl-field ${error ? 'invalid' : ''}`}>
        <input
          {...props}
          id={inputId}
          disabled={disabled || loading}
          aria-busy={loading || undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-error` : props['aria-describedby']}
        />
      </div>
      {error && (
        <p className="dl-field-error" id={`${inputId}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}
