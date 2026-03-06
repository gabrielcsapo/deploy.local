'use client';

export function LoadingState({ message = 'Loading...' }: { message?: string }) {
  return <div className="text-sm text-text-tertiary text-center py-12">{message}</div>;
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      role="alert"
    >
      {message}
    </div>
  );
}
