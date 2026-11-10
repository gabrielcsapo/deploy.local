'use client';

import { useEffect } from 'react';
import { ErrorBoundary, useRouter } from 'react-flight-router/client';
import { ErrorBanner } from './LoadingState';
import ErrorPage from '../routes/error';
import { SessionExpired } from '../routes/dashboard/v2/start/SessionExpired';
import { isUnauthorizedError as isUnauthorized } from './auth-errors';

// A render error can unmount the dashboard's dialog host. Keep a host in the
// fallback too, then retry the failed server tree after reauthentication.
function AuthErrorFallback({ error, reset }: { error?: Error; reset?: () => void }) {
  const unauthorized = isUnauthorized(error);
  const { refresh } = useRouter();
  useEffect(() => {
    if (!unauthorized) return;
    const restore = () => void refresh().then(() => reset?.());
    window.addEventListener('deploy:session-restored', restore);
    return () => window.removeEventListener('deploy:session-restored', restore);
  }, [unauthorized, refresh, reset]);
  if (unauthorized)
    return (
      <>
        <ErrorBanner message="Sign in again to continue." />
        <SessionExpired initiallyExpired />
      </>
    );
  return <ErrorPage error={error} />;
}

export function AuthErrorBoundary({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary fallback={<AuthErrorFallback />}>{children}</ErrorBoundary>;
}
