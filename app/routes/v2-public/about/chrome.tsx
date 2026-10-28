import type { ReactNode } from 'react';
import { Icon } from '../../../components/ui/v2/shared';
import './public.css';

export const sourceUrl = 'https://github.com/gabrielcsapo/deploy.local';
export function PublicPage({
  children,
  changelog = false,
}: {
  children: ReactNode;
  changelog?: boolean;
}) {
  const links = (
    <>
      <a href="/docs">Docs</a>
      <a href="/changelog" aria-current={changelog ? 'page' : undefined}>
        Changelog
      </a>
      <a href={sourceUrl}>Source</a>
    </>
  );
  return (
    <div className="dl-sheet v2-public">
      <header className="public-header">
        <div className="public-container">
          <a className="public-brand" href="/about">
            <span className="dl-mark">d</span>deploy.local
          </a>
          <nav aria-label="Public pages">{links}</nav>
          <a className="dl-btn secondary public-signin" href="/signin">
            Sign in
          </a>
          <details className="public-menu">
            <summary aria-label="Public pages">
              <Icon name="menu" />
            </summary>
            <nav>{links}</nav>
          </details>
        </div>
      </header>
      {children}
    </div>
  );
}
export function PublicFooter() {
  return (
    <footer className="public-footer">
      <div className="public-container">
        <span>deploy.local</span>
        <a href="/docs">Docs</a>
        <a href="/changelog">Changelog</a>
        <a href={sourceUrl}>Source on GitHub</a>
      </div>
    </footer>
  );
}
