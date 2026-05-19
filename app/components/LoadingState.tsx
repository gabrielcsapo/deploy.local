// Shared (no 'use client') component: when imported from a server component
// it renders on the server with no hydration cost; when imported from a
// client component it's bundled into the client chunk. Either way, no extra
// client-only chunk is emitted.
export function LoadingState({ message = 'Loading...' }: { message?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 text-sm text-text-tertiary py-12">
      <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle
          className="opacity-25"
          cx="12"
          cy="12"
          r="10"
          stroke="currentColor"
          strokeWidth="3"
        />
        <path
          className="opacity-75"
          fill="currentColor"
          d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
        />
      </svg>
      {message}
    </div>
  );
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
