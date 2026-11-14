'use client';
import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from '../../../v2-public/api';

import { useDataSeed, freshSeed } from '../data/seeds';

const SessionExpiredDialog = lazy(() => import('./SessionExpiredDialog'));

export function SessionExpired({ initiallyExpired = false }: { initiallyExpired?: boolean }) {
  const seed = useDataSeed();
  const [expired, setExpired] = useState(initiallyExpired);
  const [password, setPassword] = useState(false);
  useEffect(() => {
    // The probe catches expiry while preserving the mounted page and unsent drafts.
    const check = () =>
      api('/api/auth/account').catch((error) => {
        if (error.status === 401) setExpired(true);
      });
    const listener = () => void check();
    window.addEventListener('deploy:session-expired', listener);
    if (!freshSeed(seed, '/api/auth/account')) void check();
    const timer = setInterval(() => void check(), 30_000);
    return () => {
      clearInterval(timer);
      window.removeEventListener('deploy:session-expired', listener);
    };
  }, [seed]);
  return expired ? (
    <Suspense fallback={null}>
      <SessionExpiredDialog
        password={password}
        onPassword={() => setPassword(true)}
        onDone={() => {
          setExpired(false);
          window.dispatchEvent(new Event('deploy:session-restored'));
        }}
      />
    </Suspense>
  ) : null;
}
