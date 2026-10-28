'use client';
import { useEffect } from 'react';
import { useLocation, useRouter } from 'react-flight-router/client';
import { getAuth } from './detail/shared';
import { legacyDestination, lookupApplicationProject } from './v2-redirects';
import { Skeleton } from '@/components/ui';
export default function LegacyRedirect() {
  const { pathname } = useLocation();
  const { navigate, url } = useRouter();
  const search = new URL(url, 'http://localhost').search;
  useEffect(() => {
    const controller = new AbortController();
    const auth = getAuth();
    void legacyDestination(pathname + search + window.location.hash, (application) =>
      lookupApplicationProject(application, fetch, {
        signal: controller.signal,
        headers: auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {},
      }),
    ).then((destination) => {
      if (!controller.signal.aborted) navigate(destination || '/dashboard/live', { replace: true });
    });
    return () => controller.abort();
  }, [pathname, search, navigate]);
  return (
    <div className="dl-page">
      <Skeleton
        label="Finding the project's new page"
        slowLabel="Finding the project is taking longer than usual."
      />
    </div>
  );
}
