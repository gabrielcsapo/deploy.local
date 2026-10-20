'use client';

export function Toggle({
  enabled,
  onChange,
  label,
  checkbox = false,
  disabled = false,
}: {
  enabled: boolean;
  onChange: () => void;
  label?: string;
  checkbox?: boolean;
  disabled?: boolean;
}) {
  if (checkbox)
    return (
      <label className="ui-switch">
        <input
          type="checkbox"
          role="switch"
          className="sr-only"
          aria-label={label}
          checked={enabled}
          disabled={disabled}
          onChange={onChange}
        />
        <span aria-hidden="true" className="ui-switch-track">
          <span className="ui-switch-thumb" />
        </span>
      </label>
    );
  return (
    <button
      type="button"
      disabled={disabled}
      role="switch"
      aria-checked={enabled}
      aria-label={label}
      onClick={onChange}
      className="ui-switch"
    >
      <span aria-hidden="true" className="ui-switch-track">
        <span className="ui-switch-thumb" />
      </span>
    </button>
  );
}
