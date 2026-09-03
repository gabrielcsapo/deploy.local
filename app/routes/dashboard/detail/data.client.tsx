'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, LoadingState } from '../../../components/LoadingState';
import { useToast } from '../../../components/Toaster';
import { BackupsIcon, SitesIcon } from '../../../components/dashboard/icons';
import { getAuth, parseVolumes, useDetailContext } from './shared';

type SyncPolicy = 'none' | 'manual' | 'automatic';
type DataTopology = 'site-local' | 'syncs-across-sites' | 'follows-one-site';

interface Site {
  id: string;
  name: string;
  kind: 'home' | 'suitcase';
  mode: string;
  default_data_policy: SyncPolicy;
  revoked_at: string | null;
  last_contact_at: number | null;
}

interface Replica {
  id: string;
  app_id: string;
  site_id: string;
  runtime_status: string;
  data_mode: string;
  sync_policy: SyncPolicy;
  pending_changesets: number;
  pending_blobs: number;
  open_conflicts: number;
  readiness: {
    readyOffline?: boolean;
    runtimeReady?: boolean;
    buildReady?: boolean;
    dataReady?: boolean;
    accessReady?: boolean;
    blockers?: string[];
  };
}

interface PortabilityReport {
  id: string;
  app_id: string;
  site_id: string;
  classification: string;
  profile_digest: string | null;
  findings: unknown[];
  capability_vector: Record<string, unknown>;
  created_at: string;
}

interface ManualSyncRequest {
  id: string;
  appId: string;
  siteId: string;
  requestedBy: string;
  status: 'requested' | 'completed' | 'failed';
  requestedAt: string;
  completedAt: string | null;
  error: string | null;
  retryOf: string | null;
}

interface FleetOverview {
  sites: Site[];
  replicas: Replica[];
  reports: PortabilityReport[];
  policies: Array<{
    app_id: string;
    site_id: string;
    policy: SyncPolicy;
    conflict_policy: string;
    revision: number;
  }>;
  volumeSnapshots: Array<{
    id: string;
    app_id: string;
    authority_site_id: string;
    authority_epoch: number;
    data_sequence: number;
    verification_status: string;
    latest_home_recovery: number;
    logical_bytes: number;
    created_at: string;
  }>;
  writerTransfers: Array<{
    id: string;
    appId: string;
    sourceSiteId: string;
    targetSiteId: string;
    state: string;
    error: string | null;
    updatedAt: string;
  }>;
  manualSyncRequests: ManualSyncRequest[];
}

interface VolumeAttachment {
  id: string;
  resourceKey: string;
  componentKey: string;
  instanceId: string;
  providerVolume: string;
  mountPath: string;
  readOnly: boolean;
  state: string;
}

export default function DataClient() {
  const { deployment } = useDetailContext();
  const { toast } = useToast();
  const [overview, setOverview] = useState<FleetOverview | null>(null);
  const [attachments, setAttachments] = useState<VolumeAttachment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [savingSite, setSavingSite] = useState<string | null>(null);
  const [analyzingSite, setAnalyzingSite] = useState<string | null>(null);
  const [syncingSite, setSyncingSite] = useState<string | null>(null);
  const [draftPolicies, setDraftPolicies] = useState<Record<string, SyncPolicy>>({});
  const [draftTopologies, setDraftTopologies] = useState<Record<string, DataTopology>>({});
  const [draftWriterSites, setDraftWriterSites] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const headers = {
        'x-deploy-username': auth.username,
        'x-deploy-token': auth.token,
      };
      const [fleetResponse, runtimeResponse] = await Promise.all([
        fetch('/api/fleet/topology', { headers }),
        deployment.type === 'application-graph'
          ? fetch(`/api/deployments/${encodeURIComponent(deployment.name)}/application-runtime`, {
              headers,
            })
          : Promise.resolve(null),
      ]);
      const fleetBody = await fleetResponse.json();
      if (!fleetResponse.ok) throw new Error(fleetBody.error || 'Unable to load suitcase state');
      setOverview(fleetBody as FleetOverview);
      if (runtimeResponse?.ok) {
        const runtimeBody = await runtimeResponse.json();
        setAttachments((runtimeBody.actual?.volumes ?? []) as VolumeAttachment[]);
      } else {
        setAttachments([]);
      }
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [deployment.name, deployment.type]);

  useEffect(() => {
    void load();
  }, [load]);

  const appId = deployment.appId;
  const suitcases = useMemo(
    () => overview?.sites.filter((site) => site.kind === 'suitcase' && !site.revoked_at) ?? [],
    [overview],
  );
  const replicas = useMemo(
    () => overview?.replicas.filter((replica) => replica.app_id === appId) ?? [],
    [appId, overview],
  );
  const reports = useMemo(
    () => overview?.reports.filter((report) => report.app_id === appId) ?? [],
    [appId, overview],
  );
  const home = overview?.sites.find((site) => site.kind === 'home');
  const applicationVolumeSnapshot = overview?.volumeSnapshots.find(
    (snapshot) => snapshot.app_id === appId,
  );
  const activeWriterTransfer = overview?.writerTransfers?.find(
    (transfer) =>
      transfer.appId === appId && !['committed', 'failed', 'aborted'].includes(transfer.state),
  );
  const pendingManualSync = overview?.manualSyncRequests?.some(
    (request) => request.appId === appId && request.status === 'requested',
  );

  useEffect(() => {
    if (!pendingManualSync) return;
    const timer = window.setInterval(() => void load(), 4_000);
    return () => window.clearInterval(timer);
  }, [load, pendingManualSync]);

  async function requestManualSync(site: Site) {
    if (!appId) return;
    const auth = getAuth();
    if (!auth) return;
    setSyncingSite(site.id);
    setError('');
    try {
      const response = await fetch(`/api/fleet/apps/${encodeURIComponent(appId)}/sync`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify({ siteId: site.id }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to request manual sync');
      toast(`manual-sync-${deployment.name}-${site.id}`, {
        type: 'success',
        title: body.reused ? 'Sync already requested' : 'Sync requested',
        description: body.reused
          ? `${site.name} will consume the existing request when it next reaches Home.`
          : `${site.name} will capture and reconcile only ${deployment.name}.`,
      });
      await load();
    } catch (syncError) {
      setError(syncError instanceof Error ? syncError.message : String(syncError));
    } finally {
      setSyncingSite(null);
    }
  }

  async function keepOnSuitcase(site: Site) {
    if (!appId) return;
    const auth = getAuth();
    if (!auth) return;
    const report = reports.find((item) => item.site_id === site.id);
    const dataTopology =
      draftTopologies[site.id] ??
      (report?.classification === 'follows-one-site' ? 'follows-one-site' : 'site-local');
    const policy =
      draftPolicies[site.id] ??
      (dataTopology === 'follows-one-site' ? 'manual' : (site.default_data_policy ?? 'none'));
    const initialWriterSiteId =
      dataTopology === 'follows-one-site' ? draftWriterSites[site.id] : undefined;
    if (dataTopology === 'follows-one-site' && !initialWriterSiteId) {
      setError('Choose whether Home or this suitcase starts as the writable site.');
      return;
    }
    setSavingSite(site.id);
    setError('');
    try {
      const response = await fetch(`/api/fleet/apps/${encodeURIComponent(appId)}/replicas`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify({
          siteId: site.id,
          policy,
          dataTopology,
          initialWriterSiteId,
          conflictPolicy: 'collect',
        }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || `Unable to keep ${deployment.name} on ${site.name}`);
      toast(`keep-${deployment.name}-${site.id}`, {
        type: 'success',
        title: `Keeping ${deployment.name} on ${site.name}`,
        description:
          dataTopology === 'follows-one-site'
            ? body.writerTransfer
              ? `The writer transfer to ${site.name} is ${body.writerTransfer.state}; Home remains recoverable until commit.`
              : 'Home is the explicit initial writer; the suitcase receives verified recovery snapshots until authority moves.'
            : policy === 'none'
              ? 'The application will be portable with a separate site-local data namespace.'
              : `${policy === 'automatic' ? 'Automatic' : 'Manual'} data sync is enabled for this site.`,
      });
      await load();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingSite(null);
    }
  }

  async function analyzePortability(site: Site) {
    if (!appId) return;
    const auth = getAuth();
    if (!auth) return;
    setAnalyzingSite(site.id);
    setError('');
    try {
      const response = await fetch(
        `/api/fleet/apps/${encodeURIComponent(appId)}/portability-analysis`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({ siteId: site.id }),
        },
      );
      const report = (await response.json()) as PortabilityReport & { error?: string };
      if (!response.ok) throw new Error(report.error || 'Unable to analyze portability');
      toast(`portability-${deployment.name}-${site.id}`, {
        type: syncEligible(report.classification) ? 'success' : 'info',
        title: `Portability: ${portabilityClassLabel(report.classification)}`,
        description: syncEligible(report.classification)
          ? 'This exact application revision is eligible for multi-site reconciliation.'
          : 'The report records the safe suitcase modes and any blockers for this target.',
      });
      await load();
    } catch (analysisError) {
      setError(analysisError instanceof Error ? analysisError.message : String(analysisError));
    } finally {
      setAnalyzingSite(null);
    }
  }

  async function updatePolicy(site: Site, policy: SyncPolicy) {
    if (!appId) return;
    const auth = getAuth();
    if (!auth) return;
    setDraftPolicies((current) => ({ ...current, [site.id]: policy }));
    const replica = replicas.find((item) => item.site_id === site.id);
    if (!replica) return;
    let rejoinChoice:
      | 'replace-site-from-shared'
      | 'replace-shared-from-site'
      | 'import-site-as-new-application'
      | undefined;
    let protectedConfirmation: string | undefined;
    if (replica.sync_policy === 'none' && policy !== 'none') {
      const choice = window.prompt(
        `How should ${site.name} rejoin shared data?\n\n` +
          `replace-site-from-shared — discard the suitcase branch after a verified backup\n` +
          `replace-shared-from-site — replace Home/shared data from the suitcase branch\n` +
          `import-site-as-new-application — preserve the suitcase branch as a new app`,
        'replace-site-from-shared',
      );
      if (
        choice !== 'replace-site-from-shared' &&
        choice !== 'replace-shared-from-site' &&
        choice !== 'import-site-as-new-application'
      ) {
        setDraftPolicies((current) => ({ ...current, [site.id]: replica.sync_policy }));
        return;
      }
      rejoinChoice = choice;
      if (choice === 'replace-shared-from-site') {
        protectedConfirmation =
          window.prompt(
            `This replaces the shared Home lineage after verified backups. Type exactly:\nREPLACE SHARED DATA FROM ${site.id}`,
          ) ?? undefined;
        if (protectedConfirmation !== `REPLACE SHARED DATA FROM ${site.id}`) {
          setDraftPolicies((current) => ({ ...current, [site.id]: replica.sync_policy }));
          return;
        }
      }
    } else if (policy === 'none') {
      const confirmed = window.confirm(
        `${site.name} will fork into an independent local namespace. Future records and uploads will not reconcile until an explicit, backed-up rejoin. Continue?`,
      );
      if (!confirmed) {
        setDraftPolicies((current) => ({ ...current, [site.id]: replica.sync_policy }));
        return;
      }
    }
    setSavingSite(site.id);
    setError('');
    try {
      const response = await fetch(`/api/fleet/apps/${encodeURIComponent(appId)}/policy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify({
          siteId: site.id,
          policy,
          conflictPolicy: 'collect',
          acknowledgedRisks:
            policy === 'none'
              ? ['Site-local data will not converge with Home or other suitcases']
              : [],
          rejoinChoice,
          protectedConfirmation,
        }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to update data sync policy');
      toast(`policy-${deployment.name}-${site.id}`, {
        type: 'success',
        title:
          body.status === 'pending-target-processing'
            ? 'Verified rejoin started'
            : 'Sync policy updated',
        description:
          body.status === 'pending-target-processing'
            ? `${site.name} keeps its current policy until backups, restore, and validation complete.`
            : `${site.name} now uses ${policy === 'none' ? 'no data sync' : `${policy} sync`}.`,
      });
      setDraftPolicies((current) => {
        const next = { ...current };
        delete next[site.id];
        return next;
      });
      await load();
    } catch (saveError) {
      setDraftPolicies((current) => ({ ...current, [site.id]: replica.sync_policy }));
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setSavingSite(null);
    }
  }

  async function moveWriter(site: Site) {
    if (!appId) return;
    const auth = getAuth();
    if (!auth) return;
    setSavingSite(site.id);
    setError('');
    try {
      const headers = {
        'Content-Type': 'application/json',
        'x-deploy-username': auth.username,
        'x-deploy-token': auth.token,
      };
      const planResponse = await fetch(
        `/api/fleet/apps/${encodeURIComponent(appId)}/writer-transfer/plan`,
        { method: 'POST', headers, body: JSON.stringify({ targetSiteId: site.id }) },
      );
      const plan = await planResponse.json();
      if (!planResponse.ok) throw new Error(plan.error || 'Unable to plan writer transfer');
      if (!window.confirm(`${plan.consequence}\n\nMove the writer to ${site.name}?`)) return;
      const startResponse = await fetch(
        `/api/fleet/apps/${encodeURIComponent(appId)}/writer-transfer/start`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify({
            targetSiteId: site.id,
            expectedSnapshotId: plan.expectedSnapshotId,
            expectedAuthorityEpoch: plan.expectedAuthorityEpoch,
            expectedDataSequence: plan.expectedDataSequence,
          }),
        },
      );
      const transfer = await startResponse.json();
      if (!startResponse.ok) throw new Error(transfer.error || 'Unable to start writer transfer');
      toast(`writer-${deployment.name}-${site.id}`, {
        type: 'success',
        title: `Moving writer to ${site.name}`,
        description: `Transfer ${transfer.id} is ${transfer.state}. The old writer stays recoverable until commit.`,
      });
      await load();
    } catch (moveError) {
      setError(moveError instanceof Error ? moveError.message : String(moveError));
    } finally {
      setSavingSite(null);
    }
  }

  async function removeReplica(site: Site) {
    if (!appId) return;
    const auth = getAuth();
    if (!auth) return;
    if (
      !window.confirm(
        `Remove ${deployment.name} from ${site.name}? Any away data that has not reached Home may be lost. The last adopted checkpoint remains recorded.`,
      )
    )
      return;
    setSavingSite(site.id);
    setError('');
    try {
      const response = await fetch(`/api/fleet/apps/${encodeURIComponent(appId)}/remove-replica`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify({ siteId: site.id, acknowledgeUnreceivedDataLoss: true }),
      });
      const body = await response.json();
      if (!response.ok)
        throw new Error(body.error || 'Unable to remove the application from this Suitcase');
      toast(`remove-${deployment.name}-${site.id}`, {
        type: 'success',
        title: `Removed ${deployment.name} from ${site.name}`,
        description: body.lastAdoptedCheckpointId
          ? `Recovery boundary: ${body.lastAdoptedCheckpointId}`
          : 'No shared checkpoint had been adopted.',
      });
      await load();
    } catch (removeError) {
      setError(removeError instanceof Error ? removeError.message : String(removeError));
    } finally {
      setSavingSite(null);
    }
  }

  if (loading) return <LoadingState />;

  const legacyVolumes = parseVolumes(deployment);
  return (
    <div className="space-y-4">
      <header>
        <p className="eyebrow">Data and portability</p>
        <h2 className="mt-1 text-lg font-semibold">What travels, and how it comes home</h2>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">
          Keeping an application on a suitcase and synchronizing its data are separate decisions. No
          data sync is the safe default.
        </p>
      </header>

      {error && <ErrorBanner message={error} />}

      <section className="card overflow-hidden" aria-labelledby="suitcase-copies-title">
        <div className="border-b border-border px-4 py-4 sm:px-5">
          <div className="flex items-center gap-2">
            <SitesIcon className="size-4 text-accent" />
            <h3 id="suitcase-copies-title" className="text-sm font-semibold">
              Keep on suitcase
            </h3>
          </div>
          <p className="mt-1 text-xs text-text-tertiary">
            Each site receives the runnable release. Its data policy can stay local, sync manually,
            or sync automatically.
          </p>
        </div>
        {suitcases.length ? (
          <ul className="divide-y divide-border/80">
            {suitcases.map((site) => {
              const replica = replicas.find((item) => item.site_id === site.id);
              const report = reports.find((item) => item.site_id === site.id);
              const reconciliationEligible = Boolean(report && syncEligible(report.classification));
              const followsEligible = Boolean(
                report &&
                (report.classification === 'follows-one-site' ||
                  syncEligible(report.classification)),
              );
              const canRejoinShared = Boolean(
                replica?.sync_policy === 'none' && reconciliationEligible,
              );
              const dataTopology =
                draftTopologies[site.id] ??
                (replica
                  ? topologyFromDataMode(replica.data_mode)
                  : report?.classification === 'follows-one-site'
                    ? 'follows-one-site'
                    : 'site-local');
              const volumeSnapshot = overview?.volumeSnapshots.find(
                (snapshot) => snapshot.app_id === appId,
              );
              const authoritySite = overview?.sites.find(
                (candidate) => candidate.id === volumeSnapshot?.authority_site_id,
              );
              const policy =
                draftPolicies[site.id] ??
                replica?.sync_policy ??
                (dataTopology === 'follows-one-site'
                  ? 'manual'
                  : (site.default_data_policy ?? 'none'));
              const manualSync = overview?.manualSyncRequests?.find(
                (request) => request.appId === appId && request.siteId === site.id,
              );
              const initialWriterSiteId = draftWriterSites[site.id] ?? '';
              return (
                <li
                  key={site.id}
                  className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1fr)_minmax(180px,0.45fr)_auto] lg:items-center"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium">{site.name}</p>
                      <span
                        className={`badge ${replica ? 'badge-success' : 'bg-bg-active text-text-tertiary'}`}
                      >
                        {replica ? 'kept here' : 'not selected'}
                      </span>
                      <span className="badge bg-bg-active text-text-secondary">{site.mode}</span>
                      {replica && (
                        <span className="badge bg-bg-active text-text-secondary">
                          {dataModeLabel(replica.data_mode)}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-xs text-text-secondary">
                      {replica
                        ? readinessSummary(replica)
                        : report
                          ? portabilitySummary(report)
                          : 'Portability has not been analyzed for this site.'}
                    </p>
                    {replica ? <ReadinessPromises replica={replica} /> : null}
                    {replica?.readiness.blockers?.length ? (
                      <ul className="mt-2 space-y-1 text-[11px] text-warning">
                        {replica.readiness.blockers.slice(0, 3).map((blocker) => (
                          <li key={blocker}>• {blocker}</li>
                        ))}
                      </ul>
                    ) : null}
                    {dataTopology === 'follows-one-site' && volumeSnapshot ? (
                      <p className="mt-2 text-[11px] text-text-secondary">
                        Writer: {authoritySite?.name ?? volumeSnapshot.authority_site_id} · snapshot{' '}
                        {volumeSnapshot.data_sequence} · {volumeSnapshot.verification_status}
                        {volumeSnapshot.latest_home_recovery ? ' at Home' : ''}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <label
                      htmlFor={`topology-${site.id}`}
                      className="mb-1 block text-[10px] font-mono uppercase tracking-wider text-text-tertiary"
                    >
                      Data topology
                    </label>
                    <select
                      id={`topology-${site.id}`}
                      className="input mb-2 text-xs"
                      value={dataTopology}
                      disabled={savingSite === site.id || Boolean(replica)}
                      onChange={(event) => {
                        const next = event.target.value as DataTopology;
                        setDraftTopologies((current) => ({ ...current, [site.id]: next }));
                        setDraftPolicies((current) => ({
                          ...current,
                          [site.id]:
                            next === 'site-local'
                              ? 'none'
                              : current[site.id] === 'none' || !current[site.id]
                                ? 'manual'
                                : current[site.id],
                        }));
                      }}
                    >
                      <option value="site-local">Separate site-local data</option>
                      <option value="syncs-across-sites" disabled={!reconciliationEligible}>
                        Syncs across sites
                      </option>
                      <option value="follows-one-site" disabled={!followsEligible}>
                        Follows one site
                      </option>
                    </select>
                    <label
                      htmlFor={`policy-${site.id}`}
                      className="mb-1 block text-[10px] font-mono uppercase tracking-wider text-text-tertiary"
                    >
                      Data sync
                    </label>
                    <select
                      id={`policy-${site.id}`}
                      className="input text-xs"
                      value={policy}
                      disabled={savingSite === site.id}
                      onChange={(event) =>
                        void updatePolicy(site, event.target.value as SyncPolicy)
                      }
                    >
                      <option value="none" disabled={dataTopology !== 'site-local'}>
                        No data sync
                      </option>
                      <option
                        value="manual"
                        disabled={
                          (dataTopology === 'site-local' && !canRejoinShared) ||
                          (dataTopology === 'syncs-across-sites' && !reconciliationEligible)
                        }
                      >
                        {dataTopology === 'follows-one-site'
                          ? 'Manual recovery snapshots'
                          : 'Manual sync'}
                      </option>
                      <option
                        value="automatic"
                        disabled={
                          (dataTopology === 'site-local' && !canRejoinShared) ||
                          (dataTopology === 'syncs-across-sites' && !reconciliationEligible)
                        }
                      >
                        {dataTopology === 'follows-one-site'
                          ? 'Automatic recovery snapshots'
                          : 'Automatic sync'}
                      </option>
                    </select>
                    {dataTopology === 'follows-one-site' ? (
                      <div className="mt-2 rounded-md border border-warning/20 bg-warning/5 p-2">
                        <label
                          htmlFor={`writer-${site.id}`}
                          className="mb-1 block text-[10px] font-mono uppercase tracking-wider text-warning"
                        >
                          Initial writer
                        </label>
                        <select
                          id={`writer-${site.id}`}
                          className="input text-xs"
                          value={
                            replica
                              ? (volumeSnapshot?.authority_site_id ?? '')
                              : initialWriterSiteId
                          }
                          disabled={savingSite === site.id || Boolean(replica)}
                          onChange={(event) =>
                            setDraftWriterSites((current) => ({
                              ...current,
                              [site.id]: event.target.value,
                            }))
                          }
                        >
                          <option value="">Choose a writable site…</option>
                          {home ? (
                            <option value={home.id}>Home — keep writing at home</option>
                          ) : null}
                          <option value={site.id}>{site.name} — move writer before travel</option>
                        </select>
                        <p className="mt-1.5 text-[10px] text-warning">
                          Only the chosen site mounts this volume for writes; every other site keeps
                          a verified recovery copy.
                        </p>
                      </div>
                    ) : !reconciliationEligible ? (
                      <p className="mt-1.5 text-[10px] text-text-tertiary">
                        Manual and automatic sync unlock after a compatible portability report.
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-col items-stretch gap-2 lg:items-end">
                    {!replica ? (
                      <button
                        type="button"
                        className="btn btn-sm text-xs"
                        disabled={analyzingSite === site.id || savingSite === site.id || !appId}
                        onClick={() => void analyzePortability(site)}
                        title="Briefly quiesces the Home graph, inspects a cold snapshot, then resumes it"
                      >
                        {analyzingSite === site.id
                          ? 'Analyzing cold snapshot…'
                          : report
                            ? 'Analyze again'
                            : 'Analyze portability'}
                      </button>
                    ) : null}
                    {replica && policy === 'manual' ? (
                      <div className="flex min-w-40 flex-col items-stretch gap-1.5 lg:items-end">
                        <button
                          type="button"
                          className="btn btn-primary btn-sm text-xs"
                          disabled={
                            syncingSite === site.id ||
                            savingSite === site.id ||
                            manualSync?.status === 'requested'
                          }
                          onClick={() => void requestManualSync(site)}
                        >
                          {syncingSite === site.id
                            ? 'Requesting…'
                            : manualSync?.status === 'requested'
                              ? 'Sync requested'
                              : manualSync?.status === 'failed'
                                ? 'Retry sync'
                                : 'Sync now'}
                        </button>
                        <ManualSyncStatus request={manualSync} siteName={site.name} />
                      </div>
                    ) : null}
                    {dataTopology === 'follows-one-site' &&
                    replica &&
                    volumeSnapshot?.authority_site_id !== site.id ? (
                      <button
                        type="button"
                        className="btn btn-sm text-xs"
                        disabled={savingSite === site.id || Boolean(activeWriterTransfer)}
                        onClick={() => void moveWriter(site)}
                      >
                        Move writer here
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={`btn btn-sm text-xs ${replica ? 'text-danger' : 'btn-primary'}`}
                      disabled={
                        savingSite === site.id ||
                        analyzingSite === site.id ||
                        !appId ||
                        Boolean(activeWriterTransfer) ||
                        (!replica && dataTopology === 'follows-one-site' && !initialWriterSiteId)
                      }
                      onClick={() =>
                        replica ? void removeReplica(site) : void keepOnSuitcase(site)
                      }
                    >
                      {savingSite === site.id
                        ? 'Saving…'
                        : replica
                          ? 'Remove lost copy'
                          : 'Keep on suitcase'}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-4 py-8 text-center sm:px-5">
            <p className="text-sm font-medium">No suitcase sites are paired</p>
            <p className="mt-1 text-xs text-text-tertiary">
              Pair a suitcase from the Sites page, then return here to keep this application on it.
            </p>
            <a href="/dashboard/sites" className="btn btn-sm mt-3 text-xs">
              Open Sites
            </a>
          </div>
        )}
        {activeWriterTransfer ? (
          <div className="border-t border-border bg-warning/5 px-4 py-3 text-xs text-warning sm:px-5">
            Writer transfer {activeWriterTransfer.id}: {activeWriterTransfer.state}
          </div>
        ) : applicationVolumeSnapshot &&
          home &&
          applicationVolumeSnapshot.authority_site_id !== home.id ? (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 sm:px-5">
            <p className="text-xs text-text-secondary">
              The writer is away. Home remains a verified recovery-only copy.
            </p>
            <button
              type="button"
              className="btn btn-sm text-xs"
              disabled={savingSite === home.id}
              onClick={() => void moveWriter(home)}
            >
              Move writer Home
            </button>
          </div>
        ) : null}
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(300px,0.8fr)]">
        <section className="card overflow-hidden" aria-labelledby="volumes-title">
          <div className="border-b border-border px-4 py-4 sm:px-5">
            <div className="flex items-center gap-2">
              <BackupsIcon className="size-4 text-accent" />
              <h3 id="volumes-title" className="text-sm font-semibold">
                Volume state
              </h3>
            </div>
            <p className="mt-1 text-xs text-text-tertiary">
              Actual component attachments on the active site. Read-only and writer intent come from
              deploy.yaml.
            </p>
          </div>
          {attachments.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[680px] text-left text-xs">
                <thead className="border-b border-border bg-bg-surface/60 text-[10px] uppercase tracking-wider text-text-tertiary">
                  <tr>
                    <th className="px-4 py-2.5 font-medium">Resource</th>
                    <th className="px-4 py-2.5 font-medium">Component</th>
                    <th className="px-4 py-2.5 font-medium">Mount</th>
                    <th className="px-4 py-2.5 font-medium">Provider</th>
                    <th className="px-4 py-2.5 font-medium">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {attachments.map((item) => (
                    <tr key={item.id}>
                      <td className="px-4 py-3 font-mono text-[10px]">{item.resourceKey}</td>
                      <td className="px-4 py-3">{item.componentKey}</td>
                      <td className="px-4 py-3 font-mono text-[10px]">
                        {item.mountPath}
                        {item.readOnly ? ' · read only' : ''}
                      </td>
                      <td className="max-w-64 break-all px-4 py-3 font-mono text-[10px] text-text-secondary">
                        {item.providerVolume}
                      </td>
                      <td className="px-4 py-3 text-success">{item.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : legacyVolumes.length ? (
            <ul className="divide-y divide-border/70">
              {legacyVolumes.map((volume) => (
                <li
                  key={`${volume.hostPath}:${volume.containerPath}`}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs sm:px-5"
                >
                  <code>{volume.containerPath}</code>
                  <span className="text-text-tertiary">
                    {volume.readOnly ? 'read only' : 'writable'} · {volume.hostPath}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-4 py-6 text-xs text-text-tertiary sm:px-5">
              This application has no attached persistent volumes.
            </p>
          )}
        </section>

        <section className="card p-4 sm:p-5" aria-labelledby="portability-title">
          <h3 id="portability-title" className="text-sm font-semibold">
            Portability findings
          </h3>
          <p className="mt-1 text-xs text-text-tertiary">
            Evidence is site-specific. A runnable copy does not imply that concurrent data
            reconciliation is safe.
          </p>
          <div className="mt-4 space-y-4">
            {suitcases.map((site) => {
              const report = reports.find((item) => item.site_id === site.id);
              return (
                <div key={site.id} className="border-l-2 border-border pl-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-medium">{site.name}</p>
                    <span
                      className={`font-mono text-[10px] ${report && syncEligible(report.classification) ? 'text-success' : 'text-warning'}`}
                    >
                      {report ? portabilityClassLabel(report.classification) : 'not analyzed'}
                    </span>
                  </div>
                  {report?.findings?.length ? (
                    <ul className="mt-2 space-y-1 text-[11px] text-text-secondary">
                      {report.findings.slice(0, 4).map((finding, index) => (
                        <li key={index}>• {findingLabel(finding)}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-1 text-[11px] text-text-tertiary">
                      {report
                        ? 'No portability blockers reported.'
                        : 'Run readiness analysis after the site reports its capabilities.'}
                    </p>
                  )}
                </div>
              );
            })}
            {!suitcases.length && (
              <p className="text-xs text-text-tertiary">
                Pair a suitcase to collect portability evidence.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function readinessSummary(replica: Replica): string {
  if (replica.open_conflicts)
    return `${replica.open_conflicts} data conflict${replica.open_conflicts === 1 ? '' : 's'} needs a decision.`;
  if (replica.readiness.readyOffline) return 'Evidence-backed and ready to run offline.';
  if (replica.pending_changesets || replica.pending_blobs)
    return `${replica.pending_changesets} change set(s) and ${replica.pending_blobs} blob(s) pending.`;
  return `Runtime state: ${replica.runtime_status}.`;
}

function ReadinessPromises({ replica }: { replica: Replica }) {
  const dataReady = replica.readiness.dataReady === true;
  const useReady =
    replica.readiness.runtimeReady === true && dataReady && replica.readiness.accessReady === true;
  const developReady = useReady && replica.readiness.buildReady === true;
  const promises = [
    { label: 'Data ready', ready: dataReady },
    { label: 'Ready to use offline', ready: useReady },
    { label: 'Ready to develop offline', ready: developReady },
  ];
  return (
    <dl className="mt-2 flex flex-wrap gap-1.5" aria-label="Suitcase readiness promises">
      {promises.map((promise) => (
        <div
          key={promise.label}
          className={`rounded-full border px-2 py-0.5 text-[10px] ${
            promise.ready
              ? 'border-success/30 bg-success/[0.06] text-success'
              : 'border-border bg-bg-active text-text-tertiary'
          }`}
        >
          <dt className="inline">{promise.label}</dt>{' '}
          <dd className="inline font-mono">{promise.ready ? 'ready' : 'not ready'}</dd>
        </div>
      ))}
    </dl>
  );
}

function ManualSyncStatus({
  request,
  siteName,
}: {
  request?: ManualSyncRequest;
  siteName: string;
}) {
  if (!request) {
    return <span className="text-[10px] text-text-tertiary">No manual sync requested yet</span>;
  }
  const timestamp = new Date(request.completedAt || request.requestedAt).toLocaleString();
  if (request.status === 'requested') {
    return (
      <span className="max-w-56 text-right text-[10px] text-accent">
        Waiting for {siteName} · {timestamp}
      </span>
    );
  }
  if (request.status === 'failed') {
    return (
      <span className="max-w-56 text-right text-[10px] text-danger" title={request.error ?? ''}>
        Failed · {request.error || 'Open the request and retry'}
      </span>
    );
  }
  return <span className="text-[10px] text-success">Completed · {timestamp}</span>;
}

function portabilitySummary(report: PortabilityReport): string {
  const label = portabilityClassLabel(report.classification);
  if (syncEligible(report.classification)) return `${label}; data reconciliation is eligible.`;
  if (report.classification === 'follows-one-site') {
    return `${label}; choose one writable site and retain recovery snapshots elsewhere.`;
  }
  return `${label}; start with no data sync.`;
}

function portabilityClassLabel(classification: string): string {
  const labels: Record<string, string> = {
    'stateless-replica': 'Stateless replica',
    'file-replica': 'File replica',
    'sqlite-replica': 'SQLite replica',
    'adapter-managed-replica': 'Adapter-managed replica',
    'follows-one-site': 'Follows one site',
    'not-suitcase-compatible': 'Not suitcase compatible',
  };
  return labels[classification] ?? classification;
}

function syncEligible(classification: string): boolean {
  return [
    'stateless-replica',
    'file-replica',
    'sqlite-replica',
    'adapter-managed-replica',
  ].includes(classification);
}

function topologyFromDataMode(dataMode: string): DataTopology {
  if (dataMode.startsWith('follows-one-site')) return 'follows-one-site';
  if (dataMode === 'replicated') return 'syncs-across-sites';
  return 'site-local';
}

function dataModeLabel(dataMode: string): string {
  if (dataMode === 'follows-one-site-writer') return 'current writer';
  if (dataMode === 'follows-one-site-recovery') return 'recovery only';
  if (dataMode === 'follows-one-site-target') return 'awaiting authority';
  if (dataMode === 'replicated') return 'shared lineage';
  return 'site local';
}

function findingLabel(finding: unknown): string {
  if (typeof finding === 'string') return finding;
  if (finding && typeof finding === 'object') {
    const item = finding as { message?: unknown; code?: unknown };
    if (typeof item.message === 'string') return item.message;
    if (typeof item.code === 'string') return item.code;
  }
  return 'Portability evidence requires review.';
}
