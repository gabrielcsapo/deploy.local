'use client';

import { useState, useEffect } from 'react';
import { Link, useNavigation } from 'react-flight-router/client';

export function GlobalNavigationLoadingBar() {
  const { state } = useNavigation();

  if (state === 'idle') return null;

  return (
    <div className="h-0.5 w-full bg-bg-surface overflow-hidden fixed top-0 left-0 z-50">
      <div className="animate-progress origin-[0%_50%] w-full h-full bg-accent" />
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
            deploy.sh
          </Link>
          <nav className="flex items-center gap-6">
            <Link
              to="/docs"
              className="text-sm text-text-secondary hover:text-text transition-colors"
            >
              Docs
            </Link>
            <Link
              to="/discover"
              className="text-sm text-text-secondary hover:text-text transition-colors"
            >
              Discover
            </Link>
            <Link
              to="/dashboard"
              className="text-sm text-text-secondary hover:text-text transition-colors"
            >
              Dashboard
            </Link>
          </nav>
        </div>
      </div>
    </header>
  );
}
