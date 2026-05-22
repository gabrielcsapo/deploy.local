// Shared (no 'use client') component: when imported from a server component
// it renders on the server with no hydration cost; when imported from a
// client component it's bundled into the client chunk.
export function LoadingState({ message = 'fetching' }: { message?: string }) {
  return (
    <div
      className="flex items-center justify-center gap-2 py-14 font-mono text-sm text-text-tertiary"
      role="status"
      aria-live="polite"
    >
      <span className="text-accent">$</span>
      <span>{message}</span>
      <span className="inline-block w-1.5 h-1.5 rounded-full bg-accent animate-pulse motion-reduce:animate-none" />
    </div>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger"
      role="alert"
    >
      <span className="font-mono text-danger mr-2">!</span>
      {message}
    </div>
  );
}
