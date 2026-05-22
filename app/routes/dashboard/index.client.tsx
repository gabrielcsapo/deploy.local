'use client';

import { useState } from 'react';
import { Link } from 'react-flight-router/client';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import { HostStatusStrip } from '../../components/dashboard/HostStatusStrip';
import { FleetStrip } from '../../components/dashboard/FleetStrip';
import { FleetActivityPanel } from '../../components/dashboard/FleetActivityPanel';
import { useDashboardData } from './data.client';

/**
 * Overview — the at-a-glance fleet view. Fleet stats, traffic sparklines,
 * recent activity, and any apps that need attention. No per-app table here
 * (lives at /dashboard/apps), so the page can prioritize health signals
 * over scrolling rows.
 */
export default function OverviewClient() {
  const { deployments, aggregate, problemApps, loading, error } = useDashboardData();

  if (loading && deployments.length === 0) {
    return (
      <div>
        <HostStatusStrip />
        <div className="flex items-center justify-between mb-4">
          <h1 className="prompt-h1">Overview</h1>
        </div>
        <LoadingState />
      </div>
    );
  }

  return (
    <div>
      <HostStatusStrip />


      {error && <ErrorBanner message={error} />}

      {deployments.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <FleetStrip totals={aggregate?.totals ?? null} />
          <FleetActivityPanel />
          <ProblemBanner apps={problemApps} />
          {problemApps.length === 0 && <NominalCard deployments={deployments} />}
        </>
      )}
    </div>
  );
}

// ── Nominal card ────────────────────────────────────────────────────────────

interface NominalDeployment {
  name: string;
  updatedAt: string;
}

/**
 * Compact "we're good" callout shown when nothing is broken. Earns its row
 * by surfacing three operator-relevant numbers (apps healthy, recent
 * deploys, last deploy time) rather than just declaring nominal status and
 * pointing at /apps. Numbers are derived from data already in the dashboard
 * shell — no extra fetch.
 */
function NominalCard({ deployments }: { deployments: NominalDeployment[] }) {
  const recentMs = 24 * 60 * 60 * 1000; // count "today" as last 24h
  const now = Date.now();
  let recentDeploys = 0;
  let lastDeployTs: number | null = null;
  for (const d of deployments) {
    if (!d.updatedAt) continue;
    const ts = new Date(d.updatedAt).getTime();
    if (Number.isNaN(ts)) continue;
    if (now - ts <= recentMs) recentDeploys++;
    if (lastDeployTs === null || ts > lastDeployTs) lastDeployTs = ts;
  }
  const lastDeployLabel = lastDeployTs ? formatRelativeShort(now - lastDeployTs) : '—';

  return (
    <div className="card p-5 flex items-center justify-between flex-wrap gap-4">
      <div className="flex items-center gap-3 min-w-0">
        <span
          className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-success/12 text-success shrink-0"
          aria-hidden
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </span>
        <div>
          <p className="text-sm text-text">All systems nominal</p>
          <p className="text-xs text-text-tertiary mt-0.5">
            {deployments.length} {deployments.length === 1 ? 'app' : 'apps'} healthy across the
            fleet
          </p>
        </div>
      </div>

      <div className="flex items-center gap-6 sm:gap-8 text-xs">
        <MiniStat label="Apps" value={`${deployments.length}`} />
        <MiniStat label="Deploys · 24h" value={`${recentDeploys}`} />
        <MiniStat label="Last deploy" value={lastDeployLabel} />
      </div>

      <Link to="/dashboard/apps" className="btn btn-sm">
        View apps
        <span aria-hidden className="-mr-1">
          →
        </span>
      </Link>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="leading-tight">
      <p className="eyebrow text-[10px] mb-0.5">{label}</p>
      <p className="font-mono text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function formatRelativeShort(ms: number): string {
  if (ms < 0) return 'just now';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  return `${day}d ago`;
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

// ── Problem apps banner ─────────────────────────────────────────────────────

interface BannerApp {
  name: string;
  severity: 'down' | 'degraded' | 'healthy' | 'idle' | 'building';
  errPct: number;
  p95: number;
}

function ProblemBanner({ apps }: { apps: BannerApp[] }) {
  if (apps.length === 0) return null;
  const down = apps.filter((a) => a.severity === 'down');
  const degraded = apps.filter((a) => a.severity === 'degraded');
  return (
    <div className="card p-3 mb-4 border-warning/30 bg-warning/5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="eyebrow text-warning">Needs attention</span>
        {down.map((a) => (
          <Link
            key={`down-${a.name}`}
            to={`/dashboard/${a.name}`}
            className="badge badge-danger hover:opacity-90"
          >
            {a.name} · down
          </Link>
        ))}
        {degraded.map((a) => (
          <Link
            key={`deg-${a.name}`}
            to={`/dashboard/${a.name}`}
            className="badge badge-warning hover:opacity-90"
          >
            {a.name} · {a.errPct > 5 ? `${a.errPct.toFixed(0)}% err` : `p95 ${Math.round(a.p95)}ms`}
          </Link>
        ))}
      </div>
    </div>
  );
}
