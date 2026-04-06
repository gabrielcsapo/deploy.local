'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigation, useRouter } from 'react-flight-router/client';
import { getAuth, clearAuth } from './dashboard/detail/shared';

export function GlobalNavigationLoadingBar() {
  const { state } = useNavigation();

  if (state === 'idle') return null;

  return (
    <div className="h-0.5 w-full bg-bg-surface overflow-hidden fixed top-0 left-0 z-50">
      <div className="animate-progress origin-[0%_50%] w-full h-full bg-accent" />
    </div>
  );
}

function ProfileDropdown() {
  const [auth, setAuthState] = useState<{ username: string; token: string } | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const { navigate } = useRouter();

  useEffect(() => {
    setAuthState(getAuth());

    function handleStorage(e: StorageEvent) {
      if (e.key === 'deploy-sh-auth') {
        setAuthState(getAuth());
      }
    }
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  const handleLogout = useCallback(async () => {
    const current = getAuth();
    if (current) {
      try {
        await fetch('/api/logout', {
          headers: {
            'x-deploy-username': current.username,
            'x-deploy-token': current.token,
          },
        });
      } catch {
        // best-effort
      }
    }
    clearAuth();
    setOpen(false);
    navigate('/dashboard');
  }, [navigate]);

  if (!auth) {
    return (
      <Link
        to="/dashboard"
        className="text-sm text-text-secondary hover:text-text transition-colors"
      >
        Sign in
      </Link>
    );
  }

  const initial = auth.username.charAt(0).toUpperCase();

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="w-7 h-7 rounded-full bg-accent/15 text-accent text-xs font-semibold flex items-center justify-center hover:bg-accent/25 transition-colors"
        aria-label="Profile menu"
      >
        {initial}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 w-48 rounded-lg border border-border bg-bg-surface shadow-lg shadow-black/20 py-1 z-50">
          <div className="px-3 py-2 border-b border-border">
            <p className="text-sm font-medium text-text truncate">{auth.username}</p>
          </div>
          <Link
            to="/dashboard"
            onClick={() => setOpen(false)}
            className="block w-full text-left px-3 py-2 text-sm text-text-secondary hover:text-text hover:bg-bg-hover transition-colors"
          >
            Dashboard
          </Link>
          <button
            onClick={handleLogout}
            className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:text-text hover:bg-bg-hover transition-colors"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function AppHeader() {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    if (window.location.hostname === 'discover.local') {
      setHidden(true);
    }
  }, []);

  if (hidden) return null;

  return (
    <header className="border-b border-border">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link to="/" className="text-sm font-semibold tracking-tight text-text">
            deploy.local
          </Link>
          <nav className="flex items-center gap-6" />
        </div>
        <div className="flex items-center gap-3">
          <ProfileDropdown />
        </div>
      </div>
    </header>
  );
}
