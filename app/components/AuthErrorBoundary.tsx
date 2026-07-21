'use client';

import { useEffect } from 'react';
import { ErrorBoundary } from 'react-flight-router/client';
import { clearAuth } from '../routes/dashboard/detail/shared';
import { ErrorBanner } from './LoadingState';

// Server actions guard privileged data with `requireAuth`, which throws
// `Error('Unauthorized')` when the caller's stored token is stale or revoked
// (e.g. the control plane restarted and dropped its sessions). That rejection
// surfaces here as a render error from the flight router. A dead token can't be
// recovered client-side, so we clear the saved credentials and send the user
// back to sign in rather than leaving them staring at an error screen.

function isUnauthorized(error: Error | null | undefined) {
  return /\bunauthorized\b/i.test(error?.message ?? '');
}

function SignOutOnUnauthorized() {
  useEffect(() => {
    clearAuth();
    // Full-document navigation (not a client route change) so any RSC tree or
    // prefetch cache built with the dead token is discarded — the login screen
    // then renders from a clean slate. Guard against a redirect loop: if we're
    // already on the dashboard/login route, just reload it.
    if (window.location.pathname.startsWith('/dashboard')) {
      window.location.reload();
    } else {
      window.location.assign('/dashboard');
    }
  }, []);
  return <ErrorBanner message="Session expired — signing you back in…" />;
}

// Rendered by ErrorBoundary via cloneElement, which injects the caught `error`.
function AuthErrorFallback({ error }: { error?: Error }) {
  if (isUnauthorized(error)) return <SignOutOnUnauthorized />;
  return (
    <div className="max-w-lg mx-auto px-6 py-14">
      <ErrorBanner message={error?.message || 'Something went wrong.'} />
    </div>
  );
}

export function AuthErrorBoundary({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary fallback={<AuthErrorFallback />}>{children}</ErrorBoundary>;
}
