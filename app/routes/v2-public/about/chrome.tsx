import type { ReactNode } from 'react';
import { PublicHeader, sourceUrl, type PublicSection } from '../header.client';
import './public.css';

export { sourceUrl };
export function PublicPage({ children, current }: { children: ReactNode; current: PublicSection }) {
  return (
    <div className="dl-sheet v2-public">
      <PublicHeader current={current} />
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
