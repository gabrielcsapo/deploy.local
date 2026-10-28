'use client';

import { useEffect, useRef } from 'react';
import { ErrorBoundary, useRouter } from 'react-flight-router/client';
import { ErrorBanner } from './LoadingState';
import ErrorPage from '../routes/error';
import { SessionExpired } from '../routes/dashboard/v2/start/account.client';

function isUnauthorized(error: Error | null | undefined) {
  return /\bunauthorized\b/i.test(error?.message ?? '');
}

// A render error can unmount the dashboard's dialog host. Keep a host in the
// fallback too, then retry the failed server tree after reauthentication.
function AuthErrorFallback({ error }: { error?: Error }) {
  if (isUnauthorized(error))
    return (
      <>
        <ErrorBanner message="Sign in again to continue." />
        <SessionExpired initiallyExpired />
      </>
    );
  return <ErrorPage error={error} />;
}

export function AuthErrorBoundary({ children }: { children: React.ReactNode }) {
  const boundary = useRef<ErrorBoundary>(null);
  const { refresh } = useRouter();
  useEffect(() => {
    const restore = () => {
      if (!isUnauthorized(boundary.current?.state.error)) return;
      void refresh().then(() => boundary.current?.setState({ error: null }));
    };
    window.addEventListener('deploy:session-restored', restore);
    return () => window.removeEventListener('deploy:session-restored', restore);
  }, [refresh]);
  return (
    <ErrorBoundary ref={boundary} fallback={<AuthErrorFallback />}>
      {children}
    </ErrorBoundary>
  );
}
