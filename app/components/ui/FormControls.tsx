'use client';
import { useId, type TextareaHTMLAttributes } from 'react';
import { Button } from './index';

export function TextArea({
  label,
  error,
  id,
  className = '',
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string }) {
  const generated = useId();
  const inputId = id || generated;
  return (
    <div className={`ui-field ${className}`}>
      <label className="ui-field-label" htmlFor={inputId}>
        {label}
      </label>
      <textarea
        {...props}
        id={inputId}
        className="ui-input ui-textarea"
        aria-invalid={!!error}
        aria-describedby={error ? `${inputId}-error` : props['aria-describedby']}
      />
      {error && (
        <span className="ui-field-error" id={`${inputId}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="ui-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <Button
          key={option.value}
          variant="quiet"
          aria-pressed={value === option.value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </div>
  );
}
