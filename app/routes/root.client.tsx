'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigation, useRouter, useLocation } from 'react-flight-router/client';
import { BrandLockup } from '../components/BrandLogo';
import { OverviewIcon } from '../components/dashboard/icons';
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
    <div className="flex items-center gap-2">
      <Link
        to="/dashboard"
        className="grid h-8 w-8 place-items-center rounded-[7px] border border-border bg-bg-surface text-text-tertiary transition-colors hover:border-border-hover hover:bg-bg-hover hover:text-text"
        aria-label="Open dashboard"
        title="Dashboard"
      >
        <OverviewIcon className="size-3.5" />
      </Link>
      <div ref={ref} className="relative">
        <button
          onClick={() => setOpen(!open)}
          className="relative flex h-8 w-8 items-center justify-center rounded-[7px] border border-accent/30 bg-accent/12 font-mono text-[11px] font-semibold text-accent transition-colors hover:border-accent/60 hover:bg-accent/18"
          style={{
            boxShadow: 'inset 0 1px 0 rgb(255 255 255 / 0.06)',
          }}
          aria-label="Profile menu"
        >
          {initial}
        </button>
        {open && (
          <div className="absolute right-0 top-full z-50 mt-2 w-48 rounded-[8px] border border-border bg-bg-elevated py-1 shadow-2xl shadow-black/40">
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
    </div>
  );
}

/**
 * Search belongs to an authenticated cloud, not only a dashboard URL. On the
 * home page it carries the operator into the command center and opens the
 * same palette; on dashboard routes it opens in place.
 */
function CommandPaletteHint() {
  const { pathname } = useLocation();
  const { navigate } = useRouter();
  const [authed, setAuthed] = useState(false);
  // Keep the server render and first client render identical. Reading
  // navigator during render made macOS hydrate "Ctrl" into "⌘", which
  // triggered React #418 on every dashboard route.
  const [modLabel, setModLabel] = useState('⌘/Ctrl');
  const isMac = modLabel === '⌘';

  useEffect(() => {
    const refreshAuth = () => setAuthed(Boolean(getAuth()));
    refreshAuth();
    window.addEventListener('storage', refreshAuth);
    return () => window.removeEventListener('storage', refreshAuth);
  }, []);

  useEffect(() => {
    setModLabel(/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl');
  }, []);

  useEffect(() => {
    if (!pathname.startsWith('/dashboard')) return;
    if (window.sessionStorage.getItem('deploy:open-command-palette') !== '1') return;
    let timer = 0;
    const requestOpen = () => {
      if (window.sessionStorage.getItem('deploy:open-command-palette') !== '1') {
        if (timer) window.clearInterval(timer);
        return;
      }
      window.dispatchEvent(new CustomEvent('deploy:command-palette'));
    };
    requestOpen();
    timer = window.setInterval(requestOpen, 100);
    return () => window.clearInterval(timer);
  }, [pathname]);

  if (!authed || (pathname !== '/' && !pathname.startsWith('/dashboard'))) return null;
  const inDashboard = pathname.startsWith('/dashboard');
  return (
    <button
      type="button"
      onClick={() => {
        if (!inDashboard) {
          window.sessionStorage.setItem('deploy:open-command-palette', '1');
          navigate('/dashboard');
          return;
        }
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'k',
            metaKey: isMac,
            ctrlKey: !isMac,
            bubbles: true,
          }),
        );
      }}
      className="inline-flex size-8 items-center justify-center gap-2 rounded-[7px] border border-border bg-bg-surface font-mono text-[10px] uppercase tracking-[0.05em] text-text-tertiary transition-colors hover:border-border-hover hover:text-text-secondary sm:w-auto sm:px-2.5"
      aria-label="Search your cloud"
      title="Search your cloud"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="size-3">
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" strokeLinecap="round" />
      </svg>
      <span className="hidden sm:inline">Search</span>
      <kbd className="hidden font-mono text-[10px] text-text-tertiary/70 md:inline">
        {modLabel}K
      </kbd>
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
    <header className="sticky top-0 z-50 border-b border-border bg-[#0a0e14]/92 backdrop-blur-xl">
      <div className="mx-auto flex h-[52px] max-w-[1600px] items-center justify-between px-4 sm:px-6">
        <div className="flex items-center gap-7">
          <Link to="/" className="group text-text">
            <BrandLockup compact />
          </Link>
          <nav className="flex items-center gap-5 border-l border-border pl-5">
            <Link
              to="/docs"
              className="text-[13px] text-text-secondary transition-colors hover:text-text"
            >
              Docs
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <CommandPaletteHint />
          <a
            href="https://github.com/gabrielcsapo/deploy.local"
            target="_blank"
            rel="noopener noreferrer"
            className="text-text-secondary hover:text-text transition-colors"
            aria-label="View on GitHub"
            title="View on GitHub"
          >
            <svg viewBox="0 0 16 16" fill="currentColor" className="size-4">
              <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
          </a>
          {showAccount && <ProfileDropdown />}
        </div>
      </div>
    </header>
  );
}
