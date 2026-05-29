import { Link } from 'react-flight-router/client';
import { getRequest } from 'react-flight-router/server';

declare const __APP_VERSION__: string;

// Server component: reads the host header at render time so we don't pay for
// a separate client chunk + hydration just to conditionally render. The
// hostname is fixed per request — no client state needed.
export function AppFooter() {
  const req = getRequest();
  const host = req?.headers.get('host')?.split(':')[0] ?? '';
  if (host === 'discover.local') return null;

  // Dashboard surfaces are operator views — the sidebar is the wayfinding
  // and the four-column marketing footer reads as "convert to a product you
  // already installed." Keep the footer for marketing/docs only.
  const url = req ? new URL(req.url) : null;
  if (url?.pathname.startsWith('/dashboard')) return null;

  return (
    <footer className="border-t border-border mt-auto">
      <div className="max-w-7xl mx-auto px-6 py-10">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="col-span-2 md:col-span-1">
            <Link to="/" className="text-sm font-semibold text-text">
              deploy.local
            </Link>
            <p className="text-xs text-text-tertiary mt-2 leading-relaxed">
              Self-hosted deployment platform. Your server, your rules.
            </p>
          </div>

          {/* Product */}
          <div>
            <p className="eyebrow font-semibold mb-3">Product</p>
            <ul className="space-y-2">
              <li>
                <Link
                  to="/dashboard"
                  className="text-sm text-text-secondary hover:text-text transition-colors"
                >
                  Dashboard
                </Link>
              </li>
              <li>
                <Link
                  to="/changelog"
                  className="text-sm text-text-secondary hover:text-text transition-colors"
                >
                  Changelog
                </Link>
              </li>
            </ul>
          </div>

          {/* Resources */}
          <div>
            <p className="eyebrow font-semibold mb-3">Resources</p>
            <ul className="space-y-2">
              <li>
                <Link
                  to="/docs"
                  className="text-sm text-text-secondary hover:text-text transition-colors"
                >
                  Documentation
                </Link>
              </li>
              <li>
                <Link
                  to="/docs/cli"
                  className="text-sm text-text-secondary hover:text-text transition-colors"
                >
                  CLI Reference
                </Link>
              </li>
              <li>
                <Link
                  to="/docs/architecture"
                  className="text-sm text-text-secondary hover:text-text transition-colors"
                >
                  Architecture
                </Link>
              </li>
            </ul>
          </div>

          {/* Community */}
          <div>
            <p className="eyebrow font-semibold mb-3">Community</p>
            <ul className="space-y-2">
              <li>
                <a
                  href="https://github.com/gabrielcsapo/deploy.local"
                  className="text-sm text-text-secondary hover:text-text transition-colors inline-flex items-center gap-1.5"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <svg viewBox="0 0 16 16" fill="currentColor" className="size-3.5 shrink-0">
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/gabrielcsapo/deploy.local/issues"
                  className="text-sm text-text-secondary hover:text-text transition-colors"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Report an Issue
                </a>
              </li>
            </ul>
          </div>
        </div>

        <div className="flex items-center gap-3 mt-8 text-xs text-text-tertiary">
          <span>MIT License</span>
          <span>&middot;</span>
          <span className="font-mono">v{__APP_VERSION__}</span>
        </div>
      </div>
    </footer>
  );
}
