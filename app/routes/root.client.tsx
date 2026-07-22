'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigation, useRouter, useLocation } from 'react-flight-router/client';
import { getAuth, clearAuth } from './dashboard/detail/shared';

export function GlobalNavigationLoadingBar() {
  const { state } = useNavigation();

  if (state === 'idle') return null;

  return (
    <div className="h-0.5 w-full bg-bg-surface overflow-hidden fixed top-0 left-0 z-[60]">
      <div
        className="animate-progress origin-[0%_50%] w-full h-full"
        style={{ background: 'var(--gradient-brand)' }}
      />
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
        className="relative w-8 h-8 rounded-full text-white text-xs font-semibold flex items-center justify-center transition-shadow"
        style={{
          background: 'var(--gradient-brand)',
          boxShadow:
            '0 0 0 1px hsl(266 90% 66% / 0.35), 0 4px 14px -4px hsl(266 90% 50% / 0.5), inset 0 1px 0 0 hsl(0 0% 100% / 0.18)',
        }}
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

/**
 * Compact "⌘K" pill in the global header. Only renders on dashboard
 * pages where the command palette is mounted. Clicking it dispatches a
 * synthetic keyboard event so the existing palette listener picks it
 * up — keeps the palette as the single source of truth for opening.
 */
function CommandPaletteHint() {
  const { pathname } = useLocation();
  // Keep the server render and first client render identical. Reading
  // navigator during render made macOS hydrate "Ctrl" into "⌘", which
  // triggered React #418 on every dashboard route.
  const [modLabel, setModLabel] = useState('⌘/Ctrl');
  const isMac = modLabel === '⌘';

  useEffect(() => {
    setModLabel(/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl');
  }, []);
  if (!pathname.startsWith('/dashboard')) return null;
  return (
    <button
      type="button"
      onClick={() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            metaKey: isMac,
            ctrlKey: !isMac,
            bubbles: true,
          }),
        );
      }}
      className="hidden sm:inline-flex items-center gap-1.5 text-[11px] text-text-tertiary hover:text-text-secondary border border-white/10 hover:border-white/20 rounded-md px-2 py-1 transition-colors"
      aria-label="Open command palette"
      title="Open command palette"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
      <span>Search</span>
      <kbd className="font-mono text-[10px] text-text-tertiary/70">{modLabel}K</kbd>
    </button>
  );
}

export function AppHeader() {
  const [hidden, setHidden] = useState(false);
  const { pathname } = useLocation();

  useEffect(() => {
    if (window.location.hostname === 'discover.local') {
      setHidden(true);
    }
  }, []);

  if (hidden) return null;

  // The docs are public reference pages — they don't need the auth/account
  // affordance (sign-in link or profile menu) that the app surfaces carry.
  const showAccount = !pathname.startsWith('/docs');

  return (
    <header className="sticky top-0 z-50 border-b border-border/60 bg-bg/70 backdrop-blur-md">
      <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
        <div className="flex items-center gap-8">
          <Link
            to="/"
            className="flex items-center gap-2.5 text-sm font-semibold tracking-tight text-text group"
          >
            <span
              className="brand-mark transition-transform group-hover:rotate-[16deg]"
              aria-hidden
            />
            <span>deploy.local</span>
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              to="/docs"
              className="text-sm text-text-secondary hover:text-text transition-colors"
            >
              Docs
            </Link>
            <Link
              to="/changelog"
              className="text-sm text-text-secondary hover:text-text transition-colors"
            >
              Changelog
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <CommandPaletteHint />
          {showAccount && <ProfileDropdown />}
        </div>
      </div>
    </header>
  );
}
