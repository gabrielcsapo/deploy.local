'use client';

import { useEffect, useState } from 'react';
import { Link } from 'react-flight-router/client';
import { getAuth } from '../routes/dashboard/detail/shared';

/**
 * "Open dashboard" / "Sign in" CTA that flips its label based on whether
 * the visitor already has a session in localStorage. Avoids the awkward
 * flow where a brand-new visitor clicks "Open dashboard" and lands on a
 * login form they weren't told to expect. Server can't know auth state
 * at SSR time (token is in localStorage, not a cookie), so we render the
 * neutral default ("Open dashboard") on the server and resolve it on
 * the client after mount.
 */
export function AuthAwareCTA({ className }: { className?: string }) {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    setAuthed(getAuth() !== null);
  }, []);

  // While we don't yet know auth state, keep the neutral label so there's
  // no flash. After mount we may flip to "Sign in" for first-time visitors.
  const label = authed === false ? 'Sign in' : 'Open dashboard';

  return (
    <Link to="/dashboard" className={className ?? 'btn btn-primary'}>
      {label}
      <span aria-hidden className="-mr-1">
        →
      </span>
    </Link>
  );
}
