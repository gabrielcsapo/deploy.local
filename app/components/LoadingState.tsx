import type { ReactNode } from 'react';
export function LoadingState({ message = 'Loading…' }: { message?: string }) {
  return (
    <div className="ds-feedback ds-feedback-loading" role="status" aria-live="polite">
      <svg
        className="ds-spinner"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="8" stroke="currentColor" opacity=".25" />
        <path d="M12 4a8 8 0 0 1 8 8" stroke="currentColor" strokeWidth="2" />
      </svg>
      <span>{message}</span>
    </div>
  );
}
export function ErrorBanner({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <div className="ds-feedback ds-feedback-error" role="alert">
      <span aria-hidden="true">!</span>
      <span>{message}</span>
      {action}
    </div>
  );
}
