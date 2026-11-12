import { Skeleton } from './ui/v2/Skeleton';
import type { ReactNode } from 'react';
export function LoadingState({ message = 'Loading' }: { message?: string }) {
  return <Skeleton rows={5} label={message} />;
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
