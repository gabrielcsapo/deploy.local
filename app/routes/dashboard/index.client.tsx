'use client';

import { useState } from 'react';
import { Link } from 'react-flight-router/client';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import type { AppCardData } from '../../components/dashboard/AppCard';
import { appUrl } from './detail/shared';
import { useDashboardData } from './data.client';

/**
 * Overview — a deploy-first home for the personal cloud. Applications arrive
 * inline as they are shipped; topology remains an app-level diagnostic rather
 * than permanent dashboard chrome.
 */
export default function OverviewClient() {
  const { deployments, cards, loading, error } = useDashboardData();

  if (loading && deployments.length === 0) {
    return (
      <div className="command-center-page">
        <DashboardNav />
        <LoadingState />
      </div>
    );
  }

  return (
    <div className="command-center-page">
      <DashboardNav />

      {error && <ErrorBanner message={error} />}
      <DeploymentWorkspace cards={cards} appCount={deployments.length} />
    </div>
  );
}

function DeploymentWorkspace({ cards, appCount }: { cards: AppCardData[]; appCount: number }) {
  const healthy = cards.filter((card) => card.severity === 'healthy').length;
  const needsAttention = cards.filter(
    (card) => card.severity === 'degraded' || card.severity === 'down',
  ).length;

  return (
    <main className="mesh-workspace">
      <section className="mesh-deploy-card">
        <div className="mesh-deploy-copy">
          <span className="command-kicker">Your cloud mesh</span>
          <h2>What do you want to run?</h2>
          <p>
            Deploy a service here and it will join the mesh automatically. You can choose placement,
            data, and routes when the application needs them.
          </p>
        </div>
        <div className="mesh-deploy-actions">
          <Link to="/dashboard/catalog" className="btn btn-primary">
            Deploy from catalog
          </Link>
          <Link to="/dashboard/catalog/import" className="btn">
            Import compose
          </Link>
        </div>
        <div className="mesh-cli-deploy">
          <span>From a project</span>
          <CopyableSnippet snippet="deploy" />
        </div>
      </section>

      <section className="mesh-applications" aria-labelledby="mesh-applications-title">
        <header>
          <div>
            <span className="command-kicker">Running on your mesh</span>
            <h2 id="mesh-applications-title">Applications</h2>
          </div>
          {appCount > 0 ? (
            <p>
              <span className={needsAttention ? 'tone-warning' : 'tone-success'}>
                {needsAttention ? `${needsAttention} need attention` : `${healthy} healthy`}
              </span>
              <span>{appCount} total</span>
            </p>
          ) : null}
        </header>

        {cards.length ? (
          <div className="mesh-app-list">
            {cards.map((card) => (
              <ApplicationRow key={card.name} card={card} />
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </section>
    </main>
  );
}

function ApplicationRow({ card }: { card: AppCardData }) {
  const status =
    card.severity === 'healthy'
      ? 'Running'
      : card.severity === 'building'
        ? 'Deploying'
        : card.severity === 'idle'
          ? 'Idle'
          : card.severity === 'degraded'
            ? 'Needs attention'
            : 'Unavailable';

  return (
    <article className="mesh-app-row">
      <Link to={`/dashboard/${card.name}`} className="mesh-app-primary">
        <span className={`mesh-app-status tone-${card.severity}`} aria-hidden />
        <span>
          <strong>{card.name}</strong>
          <small>{status} · home mesh</small>
        </span>
      </Link>
      <div className="mesh-app-signals" aria-label={`${card.name} live signals`}>
        <span>
          <small>Traffic</small>
          <strong>{card.rps < 1 ? card.rps.toFixed(2) : card.rps.toFixed(1)} req/s</strong>
        </span>
        <span>
          <small>Errors</small>
          <strong className={card.errPct > 1 ? 'tone-warning' : ''}>
            {card.errPct.toFixed(1)}%
          </strong>
        </span>
      </div>
      <div className="mesh-app-actions">
        <a href={appUrl(card.name)} target="_blank" rel="noopener noreferrer">
          Open <span aria-hidden>↗</span>
        </a>
        <Link to={`/dashboard/${card.name}`}>Manage</Link>
      </div>
    </article>
  );
}

function DashboardNav() {
  return (
    <header className="command-center-heading" aria-label="Dashboard navigation">
      <nav className="command-center-nav" aria-label="Command center sections">
        <Link to="/dashboard" aria-current="page">
          Overview
        </Link>
        <Link to="/dashboard/apps">Applications</Link>
        <Link to="/dashboard/activity">Activity</Link>
        <Link to="/dashboard/nodes">Machines</Link>
        <Link to="/dashboard/sites">Sites</Link>
      </nav>
    </header>
  );
}

// ── Empty state ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="card overflow-hidden">
      <div className="px-6 py-10 border-b border-border">
        <p className="eyebrow mb-2">Getting started</p>
        <h2 className="text-lg font-semibold mb-2">Deploy your first app</h2>
        <p className="text-sm text-text-secondary max-w-[58ch]">
          Three commands from any project directory. The CLI installs from this server, so
          there&apos;s nothing to configure first.
        </p>
      </div>
      <ol className="divide-y divide-border">
        <Step
          num={1}
          title="Install the CLI"
          snippet="curl -fsSL https://deploy.local/install | sh"
          hint="Pulls the deploy binary directly from your own server."
        />
        <Step
          num={2}
          title="Register an account"
          snippet="deploy register"
          hint="One-time. Creates your operator account and saves a session token."
        />
        <Step
          num={3}
          title="Deploy a project"
          snippet="cd my-project && deploy"
          hint="Auto-detects Node.js, Docker, or static. The app appears here once it's running."
        />
      </ol>
      <div className="px-6 py-4 border-t border-border text-xs text-text-tertiary">
        See the{' '}
        <Link to="/docs" className="text-accent hover:text-accent-hover">
          docs
        </Link>{' '}
        for more, or read the{' '}
        <Link to="/docs/cli" className="text-accent hover:text-accent-hover">
          CLI reference
        </Link>
        .
      </div>
    </div>
  );
}

function Step({
  num,
  title,
  snippet,
  hint,
}: {
  num: number;
  title: string;
  snippet: string;
  hint: string;
}) {
  return (
    <li className="px-6 py-4 grid grid-cols-[auto_1fr] gap-4 items-start">
      <span
        className="inline-flex items-center justify-center w-6 h-6 rounded-full border border-border text-xs font-mono text-text-tertiary tabular-nums shrink-0 mt-0.5"
        aria-hidden
      >
        {num}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-medium mb-1.5">{title}</p>
        <CopyableSnippet snippet={snippet} />
        <p className="text-xs text-text-tertiary mt-1.5">{hint}</p>
      </div>
    </li>
  );
}

function CopyableSnippet({ snippet }: { snippet: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 bg-bg rounded px-2.5 py-1.5 border border-border max-w-fit">
      <span className="text-text-tertiary font-mono text-xs">$</span>
      <code className="text-xs font-mono text-text-secondary">{snippet}</code>
      <button
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(snippet);
            setCopied(true);
            setTimeout(() => setCopied(false), 1400);
          } catch {
            // ignore
          }
        }}
        className="ml-1 text-[10px] font-mono uppercase tracking-wider text-text-tertiary hover:text-accent transition-colors"
        aria-label={copied ? 'Copied' : 'Copy command'}
      >
        {copied ? 'copied' : 'copy'}
      </button>
    </div>
  );
}
