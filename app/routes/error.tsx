'use client';
import { Button, ErrorBanner } from '../components/ui';

export default function ErrorPage({ error }: { error?: Error; params?: Record<string, string> }) {
  return (
    <main className="p-4">
      <ErrorBanner
        message="Could not open this page."
        action={<Button onClick={() => window.location.reload()}>Reload page</Button>}
      />
      <a href="/dashboard" className="btn btn-sm">
        Open workspace
      </a>
      {error?.message && (
        <details className="mt-3 text-xs text-text-secondary">
          <summary>Error details</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words font-mono">{error.message}</pre>
        </details>
      )}
    </main>
  );
}
