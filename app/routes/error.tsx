'use client';
import { Empty } from '../components/ui/v2/Empty';
import { Action } from '../components/ui/v2/shared';
import './v2-public/about/public.css';
export default function ErrorPage(_props: { error?: Error; params?: Record<string, string> }) {
  return (
    <main className="dl-sheet v2-public public-recovery">
      <Empty
        title="Could not open this page"
        actions={
          <>
            <Action variant="primary" onClick={() => window.location.reload()}>
              Reload page
            </Action>
            <a href="/dashboard" className="dl-btn secondary">
              Home
            </a>
            <a href="/dashboard/live" className="dl-btn quiet">
              Live
            </a>
          </>
        }
      >
        Try loading it again, or check your apps in Live.
      </Empty>
    </main>
  );
}
