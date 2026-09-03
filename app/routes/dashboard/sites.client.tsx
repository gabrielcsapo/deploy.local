'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { ErrorBanner, LoadingState } from '../../components/LoadingState';
import { CopyIcon, PlusIcon, RotateIcon } from '../../components/dashboard/icons';
import { getAuth } from './detail/shared';

type SiteMode = 'docked' | 'away' | 'rejoining' | 'recovery' | 'revoked';

interface Replica {
  id: string;
  app_id: string;
  site_id: string;
  name: string;
  runtime_status: string;
  sync_policy: 'automatic' | 'manual' | 'none';
  active_release_digest: string | null;
  desired_release_digest: string | null;
  base_checkpoint_id: string | null;
  branch_checkpoint_id: string | null;
  pending_changesets: number;
  pending_blobs: number;
  last_contact_at: number | null;
  open_conflicts: number;
  release_candidates: number;
  readiness: {
    readyOffline?: boolean;
    runtimeReady?: boolean;
    buildReady?: boolean;
    dataReady?: boolean;
    accessReady?: boolean;
    blockers?: string[];
  };
}

interface Site {
  id: string;
  name: string;
  kind: 'home' | 'suitcase';
  mode: SiteMode;
  platform: string | null;
  architecture: string | null;
  version: string | null;
  default_data_policy: 'automatic' | 'manual' | 'none';
  access_mode: string;
  last_contact_at: number | null;
  revoked_at: string | null;
  credential_status: string;
  quarantine_reason: string | null;
  capabilities: Record<string, unknown>;
  readiness_summary: Record<string, unknown>;
  replicas: Replica[];
}

interface TopologyApplication {
  app_id: string;
  name: string;
  status: string;
  release_generation: number;
  replica_count: number;
  ready_replicas: number;
}

interface FleetOverview {
  fleet: { id: string; name: string; homeSiteId: string; protocolVersion: number };
  sites: Site[];
  applications: TopologyApplication[];
  replicas: Replica[];
  conflicts: Array<{
    id: string;
    app_id: string;
    app_name: string;
    changeset_id: string | null;
    kind: string;
    logical_address: string;
    base_value: unknown;
    home_value: unknown;
    suitcase_value: unknown;
    created_at: string;
  }>;
  releaseCandidates: Array<{
    id: string;
    app_id: string;
    origin_site_id: string;
    state: string;
    base_generation: number;
    architecture: string | null;
  }>;
  capacityPlan: null | {
    selected_app_ids: string[];
    minimum_memory_bytes: number;
    recommended_memory_bytes: number;
    minimum_storage_bytes: number;
    recommended_storage_bytes: number;
    confidence: string;
    unknowns: string[];
    contributors: Array<{
      category: 'memory' | 'storage';
      name: string;
      bytes: number;
      confidence: string;
      source: string;
    }>;
    evidenceSummary: null | {
      measured: number;
      declared: number;
      default: number;
      unknown: number;
      observationWindow: null | {
        startAt: string | null;
        endAt: string | null;
        sampleCount: number;
        peakAt: string | null;
      };
    };
    targetComparison: null | {
      siteId: string;
      siteName: string;
      status: 'recommended' | 'minimum-only' | 'insufficient' | 'unknown';
      ready: boolean;
      observedAt: string | null;
      memory: {
        availableBytes: number | null;
        minimumBytes: number;
        recommendedBytes: number;
        status: string;
      };
      storage: {
        availableBytes: number | null;
        minimumBytes: number;
        recommendedBytes: number;
        status: string;
      };
      blockers: string[];
      capabilities: Array<{
        name: string;
        required: boolean | string[];
        observed: boolean | string | null;
        status: 'pass' | 'block' | 'unknown';
      }>;
    };
  };
}

interface PairingResult {
  id: string;
  code: string;
  expiresAt: number;
  defaultDataPolicy: string;
}

interface SiteDiagnostics {
  access: { ready: boolean; blockers: string[]; instructions: string[] };
  sync: {
    replicas: Array<{
      policy: string;
      pendingChangesets: number;
      pendingBlobs: number;
    }>;
  };
}

function authHeaders(json = false): Record<string, string> {
  const auth = getAuth();
  return {
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(auth ? { 'x-deploy-username': auth.username, 'x-deploy-token': auth.token } : {}),
  };
}

function relativeContact(timestamp: number | null): string {
  if (!timestamp) return 'No contact yet';
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 15) return 'Contact now';
  if (seconds < 60) return `Contact ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Contact ${minutes}m ago`;
  return `Contact ${Math.floor(minutes / 60)}h ago`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value >= 10 || unit === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

function formatConflictValue(value: unknown): string {
  if (value === null || value === undefined) return 'absent';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function modeTone(mode: SiteMode): string {
  if (mode === 'docked') return 'bg-success';
  if (mode === 'away') return 'bg-accent';
  if (mode === 'rejoining') return 'bg-warning animate-pulse motion-reduce:animate-none';
  return 'bg-danger';
}

function readinessLabel(replica: Replica | undefined): { label: string; tone: string } {
  if (!replica) return { label: 'Not kept here', tone: 'text-text-tertiary' };
  if (replica.open_conflicts > 0)
    return {
      label: `${replica.open_conflicts} conflict${replica.open_conflicts === 1 ? '' : 's'}`,
      tone: 'text-danger',
    };
  if (replica.sync_policy === 'none')
    return { label: 'Local data only', tone: 'text-text-secondary' };
  if (replica.readiness.readyOffline) return { label: 'Ready offline', tone: 'text-success' };
  if (replica.pending_changesets > 0)
    return { label: `${replica.pending_changesets} pending`, tone: 'text-warning' };
  return { label: replica.runtime_status || 'Preparing', tone: 'text-warning' };
}

export default function SitesClient() {
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showPairing, setShowPairing] = useState(false);
  const [pairingName, setPairingName] = useState('Travel suitcase');
  const [pairingPolicy, setPairingPolicy] = useState<'automatic' | 'manual' | 'none'>('none');
  const [accessMode, setAccessMode] = useState('existing-lan');
  const [pairing, setPairing] = useState<PairingResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [siteAction, setSiteAction] = useState<string | null>(null);
  const [conflictAction, setConflictAction] = useState<string | null>(null);
  const [siteDiagnostics, setSiteDiagnostics] = useState<Record<string, SiteDiagnostics>>({});
  const [showPlanner, setShowPlanner] = useState(false);
  const [selectedPlanApps, setSelectedPlanApps] = useState<string[]>([]);
  const [tripHorizonDays, setTripHorizonDays] = useState(14);
  const [offlineBuilds, setOfflineBuilds] = useState(true);
  const [dailyGrowthGiB, setDailyGrowthGiB] = useState(0);
  const [retainedBackupCopies, setRetainedBackupCopies] = useState(2);
  const [capacityTargetSiteId, setCapacityTargetSiteId] = useState('');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/fleet/topology', { headers: authHeaders() });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load fleet topology');
      setOverview(body);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(interval);
  }, [load]);

  const home = overview?.sites.find((site) => site.kind === 'home');
  const suitcases = overview?.sites.filter((site) => site.kind === 'suitcase') || [];
  const problemCount =
    (overview?.conflicts.length || 0) +
    (overview?.releaseCandidates.filter((candidate) => candidate.state.includes('stale')).length ||
      0) +
    (overview?.sites.filter(
      (site) => site.kind === 'suitcase' && site.credential_status !== 'active' && !site.revoked_at,
    ).length || 0);
  const pairCommand = pairing ? `deploy suitcase pair --code ${pairing.code}` : '';

  const siteColumns = useMemo(
    () => (overview ? overview.sites.filter((site) => !site.revoked_at) : []),
    [overview],
  );

  function openPlanner() {
    setSelectedPlanApps(
      overview?.capacityPlan?.selected_app_ids.length
        ? overview.capacityPlan.selected_app_ids
        : overview?.applications.map((application) => application.app_id) || [],
    );
    setCapacityTargetSiteId(overview?.capacityPlan?.targetComparison?.siteId || '');
    setShowPlanner(true);
  }

  async function createCapacityPlan(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/fleet/capacity-plans', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          selectedAppIds: selectedPlanApps,
          tripHorizonDays,
          offlineBuilds,
          projectedDailyGrowthBytes: Math.round(dailyGrowthGiB * 1024 ** 3),
          retainedBackupCopies,
          targetSiteId: capacityTargetSiteId || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to create suitcase capacity plan');
      await load();
      setShowPlanner(false);
    } catch (planError) {
      setError(planError instanceof Error ? planError.message : String(planError));
    } finally {
      setSaving(false);
    }
  }

  async function createPairing(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError('');
    try {
      const response = await fetch('/api/fleet/pairings', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({
          name: pairingName,
          defaultDataPolicy: pairingPolicy,
          accessMode,
          securityProfile: 'isolated',
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to create pairing code');
      setPairing(body);
    } catch (pairError) {
      setError(pairError instanceof Error ? pairError.message : String(pairError));
    } finally {
      setSaving(false);
    }
  }

  async function copyPairCommand() {
    await navigator.clipboard.writeText(pairCommand);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function resolveConflict(
    conflict: FleetOverview['conflicts'][number],
    resolution: 'home' | 'suitcase' | 'keep-both',
  ) {
    const label =
      resolution === 'keep-both'
        ? 'keep both uploaded files'
        : `keep the ${resolution === 'home' ? 'Home' : 'Suitcase'} value`;
    if (
      !window.confirm(
        `Resolve ${conflict.app_name} · ${conflict.logical_address}: ${label}? deploy.local will rerun the validated merge and restore the resulting checkpoint before marking data ready.`,
      )
    )
      return;
    setConflictAction(conflict.id);
    setError('');
    try {
      const response = await fetch(
        `/api/fleet/conflicts/${encodeURIComponent(conflict.id)}/resolve`,
        {
          method: 'POST',
          headers: authHeaders(true),
          body: JSON.stringify({ resolution }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to resolve data conflict');
      await load();
    } catch (resolutionError) {
      setError(
        resolutionError instanceof Error ? resolutionError.message : String(resolutionError),
      );
    } finally {
      setConflictAction(null);
    }
  }

  async function testOfflineReadiness(site: Site) {
    setSiteAction(site.id);
    setError('');
    try {
      const response = await fetch(`/api/fleet/sites/${encodeURIComponent(site.id)}/diagnostics`, {
        headers: authHeaders(),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to test suitcase readiness');
      setSiteDiagnostics((current) => ({ ...current, [site.id]: body as SiteDiagnostics }));
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setSiteAction(null);
    }
  }

  async function revokeLostSuitcase(site: Site) {
    if (
      !window.confirm(
        `Mark ${site.name} lost and revoke its fleet credential? It will no longer synchronize, and unsynchronized data may remain only on that device.`,
      )
    )
      return;
    setSiteAction(site.id);
    setError('');
    try {
      const response = await fetch(`/api/fleet/sites/${encodeURIComponent(site.id)}/revoke`, {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ reason: 'Marked lost by administrator' }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to revoke suitcase');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setSiteAction(null);
    }
  }

  async function rotateCredentials(site?: Site) {
    const target = site ? site.name : 'every active Suitcase';
    if (
      !window.confirm(
        `Rotate the fleet credential for ${target}? Each affected device will generate its replacement during its next authenticated sync; no credential is shown in the admin portal.`,
      )
    )
      return;
    setSiteAction(site?.id || 'rotate-all');
    setError('');
    try {
      const response = await fetch('/api/suitcases/credentials/rotation', {
        method: 'POST',
        headers: authHeaders(true),
        body: JSON.stringify({ siteId: site?.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to request credential rotation');
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setSiteAction(null);
    }
  }

  if (loading) return <LoadingState />;

  return (
    <div className="space-y-6">
      <header className="page-heading">
        <div>
          <p className="eyebrow mb-2">
            Fleet graph · protocol {overview?.fleet.protocolVersion || 1}
          </p>
          <h1 className="page-title">Sites &amp; Suitcases</h1>
          <p className="page-description">
            Home keeps serving while each suitcase carries its own runnable branch. Data convergence
            and release promotion stay separate.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {suitcases.some((site) => !site.revoked_at) ? (
            <button
              type="button"
              className="btn btn-sm"
              disabled={siteAction === 'rotate-all'}
              onClick={() => void rotateCredentials()}
            >
              Rotate fleet credentials
            </button>
          ) : null}
          <button type="button" className="btn btn-sm" onClick={() => void load()}>
            <RotateIcon className="size-3.5" /> Refresh
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => setShowPairing(true)}
          >
            <PlusIcon className="size-3.5" /> Pair suitcase
          </button>
        </div>
      </header>

      {error && <ErrorBanner message={error} />}

      <section
        className="card topology-seam overflow-hidden pl-px"
        aria-labelledby="topology-title"
      >
        <div className="border-b border-border px-5 py-4 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 id="topology-title" className="text-sm font-semibold">
                Detachment seam
              </h2>
              <p className="mt-1 text-xs text-text-tertiary">
                The seam is a network boundary, not a break in ownership or history.
              </p>
            </div>
            <span
              className={`rounded-full px-2.5 py-1 font-mono text-[10px] ${problemCount ? 'bg-warning/10 text-warning' : 'bg-success/10 text-success'}`}
            >
              {problemCount
                ? `${problemCount} decision${problemCount === 1 ? '' : 's'}`
                : 'Converged'}
            </span>
          </div>
        </div>

        <div className="relative grid gap-0 lg:grid-cols-[minmax(240px,0.8fr)_96px_minmax(0,1.8fr)]">
          <div className="p-5 sm:p-6">
            {home ? (
              <SiteCard site={home} emphasis />
            ) : (
              <p className="text-sm text-danger">Home identity is missing.</p>
            )}
          </div>

          <div className="relative hidden min-h-64 items-center justify-center border-x border-dashed border-accent/35 bg-accent/[0.025] lg:flex">
            <div className="absolute inset-x-0 top-[35%] h-px bg-success/50" />
            <div className="absolute inset-x-0 top-1/2 h-px bg-accent/50" />
            <div className="absolute inset-x-0 top-[65%] h-px bg-warning/50" />
            <div className="relative rotate-[-90deg] whitespace-nowrap rounded-full border border-accent/25 bg-bg px-3 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-accent">
              detach / rejoin
            </div>
          </div>

          <div className="border-t border-dashed border-accent/25 p-5 sm:p-6 lg:border-t-0">
            {suitcases.length > 0 ? (
              <div className="grid gap-4 xl:grid-cols-2">
                {suitcases.map((site) => (
                  <SiteCard
                    key={site.id}
                    site={site}
                    diagnostics={siteDiagnostics[site.id]}
                    busy={siteAction === site.id}
                    onTest={() => void testOfflineReadiness(site)}
                    onRotate={() => void rotateCredentials(site)}
                    onRevoke={() => void revokeLostSuitcase(site)}
                  />
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowPairing(true)}
                className="flex min-h-52 w-full flex-col items-center justify-center rounded-lg border border-dashed border-border px-6 text-center transition-colors hover:border-accent/50 hover:bg-accent/[0.025]"
              >
                <span className="mb-3 grid size-10 place-items-center rounded-full bg-accent/10 text-accent">
                  <PlusIcon />
                </span>
                <span className="text-sm font-medium">Add the first suitcase site</span>
                <span className="mt-1 max-w-sm text-xs text-text-tertiary">
                  Start the Docker target on a Mac, Linux, Windows, amd64, or arm64 device. Pairing
                  keeps its identity distinct from Home.
                </span>
              </button>
            )}
          </div>

          <div className="col-span-full hidden grid-cols-3 border-t border-border bg-bg-surface/50 px-6 py-2.5 font-mono text-[9px] uppercase tracking-wider text-text-tertiary lg:grid">
            <span className="text-success">Control events</span>
            <span className="text-accent">Data checkpoints</span>
            <span className="text-warning">Release candidates</span>
          </div>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="card overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <h2 className="text-sm font-semibold">Application placement</h2>
            <p className="mt-1 text-xs text-text-tertiary">
              One row per stable application identity. A green site cell is evidence-backed
              readiness, not simple container uptime.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-border bg-bg-surface/70 text-[10px] uppercase tracking-wider text-text-tertiary">
                <tr>
                  <th className="px-5 py-3 font-medium">Application</th>
                  {siteColumns.map((site) => (
                    <th key={site.id} className="px-4 py-3 font-medium">
                      {site.name}
                    </th>
                  ))}
                  <th className="px-4 py-3 font-medium">Release</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {overview?.applications.map((application) => (
                  <tr key={application.app_id} className="hover:bg-bg-hover/40">
                    <td className="px-5 py-3.5">
                      <a
                        href={`/dashboard/${encodeURIComponent(application.name)}`}
                        className="font-medium hover:text-accent"
                      >
                        {application.name}
                      </a>
                      <p className="mt-1 font-mono text-[9px] text-text-tertiary">
                        {application.app_id}
                      </p>
                    </td>
                    {siteColumns.map((site) => {
                      const replica = overview.replicas.find(
                        (item) => item.app_id === application.app_id && item.site_id === site.id,
                      );
                      const state =
                        site.kind === 'home' && !replica
                          ? {
                              label:
                                application.status === 'running'
                                  ? 'Running at Home'
                                  : application.status || 'Home application',
                              tone:
                                application.status === 'running'
                                  ? 'text-success'
                                  : 'text-text-secondary',
                            }
                          : readinessLabel(replica);
                      return (
                        <td key={site.id} className="px-4 py-3.5">
                          <p className={`font-medium ${state.tone}`}>{state.label}</p>
                          {replica && (
                            <>
                              <p className="mt-1 font-mono text-[9px] text-text-tertiary">
                                {replica.sync_policy === 'none'
                                  ? 'no data sync'
                                  : `${replica.sync_policy} sync`}
                              </p>
                              <p className="mt-1 text-[9px] text-text-tertiary">
                                Data {replica.readiness.dataReady ? 'ready' : 'pending'} · use{' '}
                                {replica.readiness.runtimeReady &&
                                replica.readiness.dataReady &&
                                replica.readiness.accessReady
                                  ? 'ready'
                                  : 'pending'}{' '}
                                · develop{' '}
                                {replica.readiness.runtimeReady &&
                                replica.readiness.dataReady &&
                                replica.readiness.accessReady &&
                                replica.readiness.buildReady
                                  ? 'ready'
                                  : 'pending'}
                              </p>
                              <dl className="mt-2 space-y-1 border-t border-border/60 pt-2 font-mono text-[9px] text-text-tertiary">
                                <div className="flex justify-between gap-2">
                                  <dt>Base checkpoint</dt>
                                  <dd
                                    className="max-w-28 truncate text-text-secondary"
                                    title={replica.base_checkpoint_id || 'none'}
                                  >
                                    {replica.base_checkpoint_id || 'none'}
                                  </dd>
                                </div>
                                {replica.branch_checkpoint_id && (
                                  <div className="flex justify-between gap-2 text-warning">
                                    <dt>Detached branch</dt>
                                    <dd
                                      className="max-w-28 truncate"
                                      title={replica.branch_checkpoint_id}
                                    >
                                      {replica.branch_checkpoint_id}
                                    </dd>
                                  </div>
                                )}
                                <div className="flex justify-between gap-2">
                                  <dt>Data lag</dt>
                                  <dd className="text-text-secondary">
                                    {replica.pending_changesets + replica.pending_blobs > 0
                                      ? `${replica.pending_changesets + replica.pending_blobs} pending`
                                      : 'converged'}
                                  </dd>
                                </div>
                                <div className="flex justify-between gap-2">
                                  <dt>Active release</dt>
                                  <dd
                                    className="max-w-28 truncate text-text-secondary"
                                    title={
                                      replica.active_release_digest ||
                                      replica.desired_release_digest ||
                                      'pending'
                                    }
                                  >
                                    {replica.active_release_digest ||
                                      replica.desired_release_digest ||
                                      'pending'}
                                  </dd>
                                </div>
                                <div className="flex justify-between gap-2">
                                  <dt>Last contact</dt>
                                  <dd className="text-text-secondary">
                                    {relativeContact(
                                      replica.last_contact_at || site.last_contact_at,
                                    )}
                                  </dd>
                                </div>
                              </dl>
                            </>
                          )}
                          {site.kind === 'home' && !replica ? (
                            <p className="mt-1 font-mono text-[9px] text-text-tertiary">
                              release authority
                            </p>
                          ) : null}
                        </td>
                      );
                    })}
                    <td className="px-4 py-3.5 font-mono text-[10px] text-text-secondary">
                      generation {application.release_generation}
                    </td>
                  </tr>
                ))}
                {!overview?.applications.length && (
                  <tr>
                    <td
                      colSpan={siteColumns.length + 2}
                      className="px-5 py-10 text-center text-text-tertiary"
                    >
                      Deploy an application to see its site placement.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <aside className="space-y-4">
          <div className="card p-5">
            <div className="flex items-center justify-between gap-3">
              <p className="eyebrow">Suitcase estimate</p>
              <button type="button" className="btn btn-sm text-xs" onClick={openPlanner}>
                {overview?.capacityPlan ? 'Recalculate' : 'Plan suitcase'}
              </button>
            </div>
            {overview?.capacityPlan ? (
              <>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  <div>
                    <p className="font-mono text-lg font-semibold">
                      {formatBytes(overview.capacityPlan.recommended_memory_bytes)}
                    </p>
                    <p className="text-[10px] text-text-tertiary">Recommended RAM</p>
                  </div>
                  <div>
                    <p className="font-mono text-lg font-semibold">
                      {formatBytes(overview.capacityPlan.recommended_storage_bytes)}
                    </p>
                    <p className="text-[10px] text-text-tertiary">Recommended storage</p>
                  </div>
                </div>
                <p className="mt-3 text-xs text-text-secondary">
                  {overview.capacityPlan.confidence} confidence ·{' '}
                  {overview.capacityPlan.unknowns.length} unknown input
                  {overview.capacityPlan.unknowns.length === 1 ? '' : 's'}
                </p>
                {overview.capacityPlan.evidenceSummary && (
                  <div className="mt-3 flex flex-wrap gap-1.5 text-[9px] font-mono uppercase tracking-wide">
                    <span className="rounded border border-success/30 bg-success/5 px-2 py-1 text-success">
                      {overview.capacityPlan.evidenceSummary.measured} measured
                    </span>
                    <span className="rounded border border-border px-2 py-1 text-text-secondary">
                      {overview.capacityPlan.evidenceSummary.declared} declared
                    </span>
                    <span className="rounded border border-warning/30 bg-warning/5 px-2 py-1 text-warning">
                      {overview.capacityPlan.evidenceSummary.default} defaults
                    </span>
                    <span className="rounded border border-danger/30 bg-danger/5 px-2 py-1 text-danger">
                      {overview.capacityPlan.evidenceSummary.unknown} unknown
                    </span>
                  </div>
                )}
                {overview.capacityPlan.targetComparison && (
                  <div
                    className={`mt-4 rounded-lg border p-3 ${
                      overview.capacityPlan.targetComparison.status === 'insufficient'
                        ? 'border-danger/40 bg-danger/5'
                        : overview.capacityPlan.targetComparison.status === 'unknown'
                          ? 'border-warning/40 bg-warning/5'
                          : 'border-success/30 bg-success/5'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-xs font-medium">
                        {overview.capacityPlan.targetComparison.siteName}
                      </p>
                      <span className="font-mono text-[9px] uppercase tracking-wide">
                        {overview.capacityPlan.targetComparison.status.replace('-', ' ')}
                      </span>
                    </div>
                    <dl className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-text-secondary">
                      <div>
                        <dt className="text-text-tertiary">Probed RAM</dt>
                        <dd className="font-mono">
                          {formatBytes(
                            overview.capacityPlan.targetComparison.memory.availableBytes || 0,
                          )}{' '}
                          · min{' '}
                          {formatBytes(overview.capacityPlan.targetComparison.memory.minimumBytes)}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-text-tertiary">Probed free storage</dt>
                        <dd className="font-mono">
                          {formatBytes(
                            overview.capacityPlan.targetComparison.storage.availableBytes || 0,
                          )}{' '}
                          · min{' '}
                          {formatBytes(overview.capacityPlan.targetComparison.storage.minimumBytes)}
                        </dd>
                      </div>
                    </dl>
                    {overview.capacityPlan.targetComparison.blockers.length > 0 && (
                      <ul className="mt-2 space-y-1 text-[10px] text-danger">
                        {overview.capacityPlan.targetComparison.blockers.map((blocker) => (
                          <li key={blocker}>• {blocker}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
                <details className="mt-3 border-t border-border pt-3">
                  <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
                    Assumptions and contributors
                  </summary>
                  <ul className="mt-2 space-y-1.5">
                    {overview.capacityPlan.contributors.map((contributor) => (
                      <li
                        key={`${contributor.category}-${contributor.name}`}
                        className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[10px] text-text-secondary"
                      >
                        <span>{contributor.name}</span>
                        <span className="shrink-0 font-mono">{formatBytes(contributor.bytes)}</span>
                        <span className="col-span-2 text-[9px] text-text-tertiary">
                          {contributor.confidence} · {contributor.source}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
                {overview.capacityPlan.unknowns.length > 0 && (
                  <details className="mt-3 border-t border-border pt-3">
                    <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-wider text-warning">
                      Evidence gaps
                    </summary>
                    <ul className="mt-2 space-y-1 text-[10px] text-text-secondary">
                      {overview.capacityPlan.unknowns.map((unknown) => (
                        <li key={unknown}>• {unknown}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            ) : (
              <p className="mt-3 text-xs text-text-tertiary">
                Select portable apps, trip horizon, retention, and offline-build needs to calculate
                hardware from the workload.
              </p>
            )}
          </div>
          <div className="card decision-surface p-5">
            <p className="eyebrow">Needs a decision</p>
            <div className="mt-3 space-y-3">
              {overview?.conflicts.slice(0, 3).map((conflict) => (
                <div key={conflict.id} className="border-l-2 border-danger pl-3">
                  <p className="text-xs font-medium">
                    {conflict.app_name} · {conflict.kind}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-[9px] text-text-tertiary">
                    {conflict.logical_address}
                  </p>
                  <details className="mt-2">
                    <summary className="cursor-pointer text-[10px] text-text-secondary">
                      Compare branches
                    </summary>
                    <dl className="mt-2 grid gap-1.5 text-[9px]">
                      {(['base', 'home', 'suitcase'] as const).map((branch) => {
                        const value = conflict[`${branch}_value`];
                        const display = formatConflictValue(value);
                        return (
                          <div key={branch} className="rounded border border-border bg-bg/50 p-2">
                            <dt className="font-mono uppercase text-text-tertiary">{branch}</dt>
                            <dd className="mt-0.5 break-all text-text-secondary" title={display}>
                              {display.length > 180 ? `${display.slice(0, 180)}…` : display}
                            </dd>
                          </div>
                        );
                      })}
                    </dl>
                  </details>
                  {conflict.kind === 'schema' || conflict.kind === 'validation' ? (
                    <p className="mt-2 text-[10px] text-warning">
                      Create a new validated branch; this conflict cannot be value-picked safely.
                    </p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      <button
                        type="button"
                        className="btn btn-sm text-[10px]"
                        disabled={conflictAction === conflict.id}
                        onClick={() => void resolveConflict(conflict, 'home')}
                      >
                        Keep Home
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm text-[10px]"
                        disabled={conflictAction === conflict.id}
                        onClick={() => void resolveConflict(conflict, 'suitcase')}
                      >
                        Keep Suitcase
                      </button>
                      {conflict.kind === 'file-path' && (
                        <button
                          type="button"
                          className="btn btn-sm text-[10px]"
                          disabled={conflictAction === conflict.id}
                          onClick={() => void resolveConflict(conflict, 'keep-both')}
                        >
                          Keep both
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {overview?.releaseCandidates.slice(0, 3).map((candidate) => (
                <div key={candidate.id} className="border-l-2 border-warning pl-3">
                  <p className="text-xs font-medium">
                    Release {candidate.state.replaceAll('-', ' ')}
                  </p>
                  <p className="mt-0.5 font-mono text-[9px] text-text-tertiary">
                    base generation {candidate.base_generation}
                  </p>
                </div>
              ))}
              {!overview?.conflicts.length && !overview?.releaseCandidates.length && (
                <p className="text-xs text-text-tertiary">
                  No data conflicts or release decisions are waiting.
                </p>
              )}
            </div>
          </div>
        </aside>
      </section>

      {showPlanner && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setShowPlanner(false);
          }}
        >
          <form
            className="card max-h-[88vh] w-full max-w-xl overflow-y-auto p-6"
            onSubmit={createCapacityPlan}
            aria-labelledby="capacity-plan-title"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow">Hardware from workload</p>
                <h2 id="capacity-plan-title" className="mt-1 text-lg font-semibold">
                  Plan a suitcase
                </h2>
                <p className="mt-1 text-xs text-text-secondary">
                  Choose what travels. The result explains measured, declared, estimated, and
                  unknown contributors without prescribing a device brand.
                </p>
              </div>
              <button
                type="button"
                className="btn btn-sm text-xs"
                onClick={() => setShowPlanner(false)}
              >
                Close
              </button>
            </div>

            <fieldset className="mt-5">
              <legend className="text-xs font-medium">Applications to keep portable</legend>
              <div className="mt-2 grid gap-2 sm:grid-cols-2">
                {overview?.applications.map((application) => (
                  <label
                    key={application.app_id}
                    className="flex items-center gap-2 rounded-lg border border-border bg-bg/40 px-3 py-2 text-xs"
                  >
                    <input
                      type="checkbox"
                      checked={selectedPlanApps.includes(application.app_id)}
                      onChange={(event) =>
                        setSelectedPlanApps((current) =>
                          event.target.checked
                            ? [...new Set([...current, application.app_id])]
                            : current.filter((appId) => appId !== application.app_id),
                        )
                      }
                    />
                    <span className="min-w-0 truncate">{application.name}</span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="mt-5 grid gap-4 sm:grid-cols-2">
              <label className="text-xs sm:col-span-2">
                <span className="mb-1 block text-text-secondary">
                  Compare with a paired target (optional)
                </span>
                <select
                  className="input"
                  value={capacityTargetSiteId}
                  onChange={(event) => setCapacityTargetSiteId(event.target.value)}
                >
                  <option value="">Pre-purchase estimate only</option>
                  {suitcases
                    .filter((site) => !site.revoked_at)
                    .map((site) => (
                      <option key={site.id} value={site.id}>
                        {site.name} · {site.architecture || 'architecture unknown'}
                      </option>
                    ))}
                </select>
                <span className="mt-1 block text-[10px] text-text-tertiary">
                  A paired target uses its latest RAM, free-storage, architecture, Docker, and host
                  capability probes for the final comparison.
                </span>
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-text-secondary">Trip horizon (days)</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={3650}
                  value={tripHorizonDays}
                  onChange={(event) => setTripHorizonDays(Number(event.target.value))}
                  required
                />
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-text-secondary">Retained backup copies</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  value={retainedBackupCopies}
                  onChange={(event) => setRetainedBackupCopies(Number(event.target.value))}
                  required
                />
              </label>
              <label className="text-xs">
                <span className="mb-1 block text-text-secondary">
                  Expected data growth per day (GiB)
                </span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  step="0.1"
                  value={dailyGrowthGiB}
                  onChange={(event) => setDailyGrowthGiB(Number(event.target.value))}
                  required
                />
              </label>
              <label className="flex items-center gap-2 self-end rounded-lg border border-border px-3 py-2.5 text-xs">
                <input
                  type="checkbox"
                  checked={offlineBuilds}
                  onChange={(event) => setOfflineBuilds(event.target.checked)}
                />
                Include independent offline builds
              </label>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button type="button" className="btn" onClick={() => setShowPlanner(false)}>
                Cancel
              </button>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={saving || selectedPlanApps.length === 0}
              >
                {saving ? 'Calculating…' : 'Calculate requirements'}
              </button>
            </div>
          </form>
        </div>
      )}

      {showPairing && (
        <div
          className="fixed inset-0 z-50 grid place-items-center bg-black/65 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) setShowPairing(false);
          }}
        >
          <div
            className="card w-full max-w-lg p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pair-title"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="eyebrow mb-1">New site identity</p>
                <h2 id="pair-title" className="text-lg font-semibold">
                  Pair a suitcase
                </h2>
              </div>
              <button
                type="button"
                className="text-text-tertiary hover:text-text"
                onClick={() => setShowPairing(false)}
                aria-label="Close"
              >
                ×
              </button>
            </div>
            {pairing ? (
              <div className="mt-5">
                <p className="text-sm text-text-secondary">
                  Run this after <code>deploy suitcase target start</code> on the portable device.
                  The code is one-use and expires automatically.
                </p>
                <div className="mt-4 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/[0.04] p-3">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-xs text-accent">
                    {pairCommand}
                  </code>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void copyPairCommand()}
                  >
                    <CopyIcon className="size-3.5" /> {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <p className="mt-3 text-xs text-text-tertiary">
                  Default:{' '}
                  {pairing.defaultDataPolicy === 'none'
                    ? 'No application data sync'
                    : `${pairing.defaultDataPolicy} data sync`}
                  . Every app can be changed separately later.
                </p>
              </div>
            ) : (
              <form className="mt-5 space-y-4" onSubmit={createPairing}>
                <label className="block">
                  <span className="eyebrow mb-1.5 block">Suitcase name</span>
                  <input
                    className="input"
                    value={pairingName}
                    onChange={(event) => setPairingName(event.target.value)}
                    required
                  />
                </label>
                <fieldset>
                  <legend className="eyebrow mb-2">Default data behavior</legend>
                  <div className="grid gap-2 sm:grid-cols-3">
                    {(
                      [
                        ['none', 'No sync', 'Each site keeps separate data.'],
                        ['manual', 'Manual', 'Transfer only after Sync now.'],
                        ['automatic', 'Automatic', 'Reconcile while connected.'],
                      ] as const
                    ).map(([value, label, description]) => (
                      <label
                        key={value}
                        className={`cursor-pointer rounded-lg border p-3 ${pairingPolicy === value ? 'border-accent bg-accent/[0.06]' : 'border-border'}`}
                      >
                        <input
                          type="radio"
                          className="sr-only"
                          name="policy"
                          value={value}
                          checked={pairingPolicy === value}
                          onChange={() => setPairingPolicy(value)}
                        />
                        <span className="block text-xs font-medium">{label}</span>
                        <span className="mt-1 block text-[10px] leading-relaxed text-text-tertiary">
                          {description}
                        </span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="block">
                  <span className="eyebrow mb-1.5 block">Offline access</span>
                  <select
                    className="input"
                    value={accessMode}
                    onChange={(event) => setAccessMode(event.target.value)}
                  >
                    <option value="existing-lan">Existing LAN / travel router</option>
                    <option value="host-hotspot">User-enabled host hotspot</option>
                    <option value="linux-access-point">Validated Linux access point</option>
                  </select>
                </label>
                <div className="rounded-md border border-border bg-bg-surface p-3 text-xs text-text-tertiary">
                  Pairing creates a distinct Ed25519 site identity and credential. It does not clone
                  Home or execution-node access.
                </div>
                <div className="flex justify-end gap-2">
                  <button type="button" className="btn" onClick={() => setShowPairing(false)}>
                    Cancel
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={saving}>
                    {saving ? 'Creating…' : 'Create pairing code'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SiteCard({
  site,
  emphasis = false,
  diagnostics,
  busy = false,
  onTest,
  onRotate,
  onRevoke,
}: {
  site: Site;
  emphasis?: boolean;
  diagnostics?: SiteDiagnostics;
  busy?: boolean;
  onTest?: () => void;
  onRotate?: () => void;
  onRevoke?: () => void;
}) {
  const ready = site.replicas.filter((replica) => replica.readiness.readyOffline).length;
  const pending = diagnostics?.sync.replicas.reduce(
    (total, replica) => total + replica.pendingChangesets + replica.pendingBlobs,
    0,
  );
  return (
    <article
      className={`relative overflow-hidden rounded-lg border p-4 ${emphasis ? 'border-success/35 bg-success/[0.035]' : 'border-border bg-bg-surface/45'}`}
    >
      <div className={`absolute inset-y-0 left-0 w-0.5 ${modeTone(site.mode)}`} />
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${modeTone(site.mode)}`} />
            <h3 className="text-sm font-semibold">{site.name}</h3>
          </div>
          <p className="mt-1.5 font-mono text-[9px] uppercase tracking-wider text-text-tertiary">
            {site.kind} · {site.mode}
          </p>
        </div>
        <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[9px] text-text-tertiary">
          {site.platform || 'unknown'}/{site.architecture || 'unknown'}
        </span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 border-t border-border/70 pt-4">
        <div>
          <p className="font-mono text-base font-semibold">
            {site.kind === 'home' ? 'Home' : `${ready}/${site.replicas.length}`}
          </p>
          <p className="text-[10px] text-text-tertiary">
            {site.kind === 'home' ? 'Fleet authority' : 'Ready offline'}
          </p>
        </div>
        <div>
          <p className="font-mono text-xs font-semibold capitalize">
            {site.default_data_policy.replace('-', ' ')}
          </p>
          <p className="text-[10px] text-text-tertiary">Default data policy</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-text-tertiary">
        <span>{relativeContact(site.last_contact_at)}</span>
        <span className="truncate font-mono">{site.access_mode.replaceAll('-', ' ')}</span>
      </div>
      {site.kind === 'suitcase' && site.credential_status !== 'active' ? (
        <div className="mt-3 rounded-md border border-warning/30 bg-warning/[0.04] p-3 text-[10px]">
          <p className="font-medium text-warning">
            {site.credential_status === 'recovery-pending'
              ? 'Recovered Home is awaiting signed re-adoption'
              : site.credential_status === 'rotation-required'
                ? 'Credential rotation will complete on next sync'
                : `Credential state: ${site.credential_status}`}
          </p>
          {site.quarantine_reason ? (
            <p className="mt-1 break-words text-text-tertiary">{site.quarantine_reason}</p>
          ) : null}
        </div>
      ) : null}
      {diagnostics ? (
        <div
          className={`mt-3 rounded-md border p-3 text-[10px] ${diagnostics.access.ready ? 'border-success/25 bg-success/[0.04]' : 'border-warning/30 bg-warning/[0.04]'}`}
        >
          <p className={diagnostics.access.ready ? 'text-success' : 'text-warning'}>
            {diagnostics.access.ready
              ? 'Offline access preflight passed'
              : 'Offline access needs work'}{' '}
            · {pending || 0} pending data item{pending === 1 ? '' : 's'}
          </p>
          {(diagnostics.access.blockers.length
            ? diagnostics.access.blockers
            : diagnostics.access.instructions.slice(0, 1)
          ).map((message) => (
            <p key={message} className="mt-1 text-text-tertiary">
              {message}
            </p>
          ))}
          {diagnostics.sync.replicas.some((replica) => replica.policy === 'manual') ? (
            <p className="mt-1 text-text-tertiary">
              Manual apps transfer when an administrator runs <code>deploy suitcase sync now</code>{' '}
              on this site.
            </p>
          ) : null}
        </div>
      ) : null}
      {site.kind === 'suitcase' ? (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border/70 pt-3">
          <button type="button" className="btn btn-sm text-[10px]" disabled={busy} onClick={onTest}>
            {busy ? 'Checking…' : 'Test offline readiness'}
          </button>
          <button
            type="button"
            className="btn btn-sm text-[10px]"
            disabled={busy || site.credential_status === 'recovery-pending'}
            onClick={onRotate}
          >
            Rotate credential
          </button>
          <button
            type="button"
            className="btn btn-sm text-[10px] text-danger"
            disabled={busy}
            onClick={onRevoke}
          >
            Mark lost &amp; revoke
          </button>
        </div>
      ) : null}
    </article>
  );
}
