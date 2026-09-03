'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner } from '../../../components/LoadingState';
import { getAuth } from './shared';

interface RuntimeComponent {
  name: string;
  role: string;
  desiredInstances: number;
  defaultInstances: number;
  minimumReady: number;
  siteOverrides: { allowed: boolean; minimum: number; maximum: number };
  dependencies: readonly string[];
  interfaces: Record<string, { port: number; protocol: string }>;
  mounts: Record<string, { resource: string; readOnly: boolean }>;
  source: { kind: 'image'; reference: string } | { kind: 'build'; context: string };
  profile?: {
    profile: string;
    operations: Array<{
      id: string;
      workflow?: string;
      destructive: boolean;
    }>;
  };
}

interface RuntimeService {
  id: string;
  component: string;
  interface: string;
  protocol: string;
  containerPort: number;
}

interface RuntimeActual {
  placements: Array<{
    componentKey: string;
    desiredInstances: number;
    state: string;
    profile: string | null;
  }>;
  instances: Array<{
    id: string;
    componentKey: string;
    slotKey: string;
    image: string;
    containerName: string;
    status: string;
    health: string;
    releaseDigest: string;
    readyAt: number | null;
  }>;
  services: Array<{
    id: string;
    componentKey: string;
    interfaceKey: string;
    protocol: string;
    containerPort: number;
    published: boolean;
    membershipGeneration: number;
  }>;
  endpoints: Array<{
    id: string;
    serviceId: string;
    instanceId: string;
    host: string;
    port: number;
    readiness: string;
    admittedGeneration: number;
  }>;
  jobs: Array<{
    idempotencyKey: string;
    jobKey: string;
    componentKey: string;
    scope: string;
    status: string;
    attempts: number;
    completedAt: number | null;
  }>;
  volumes: Array<{
    id: string;
    resourceKey: string;
    componentKey: string;
    instanceId: string;
    providerVolume: string;
    mountPath: string;
    readOnly: boolean;
    state: string;
  }>;
  profileOperations: Array<{
    id: string;
    componentKey: string;
    profile: string;
    operation: string;
    status: string;
    artifactDigest: string | null;
    sourceSpecDigest: string | null;
    targetSpecDigest: string | null;
    sourceVolume: string | null;
    targetVolume: string | null;
    rollbackVolume: string | null;
    verification: string | null;
    completedAt: number | null;
  }>;
  profileVolumeBindings: Array<{
    componentKey: string;
    resourceKey: string;
    activeProviderVolume: string;
    rollbackProviderVolume: string | null;
    activeSpecDigest: string;
    rollbackSpecDigest: string | null;
    artifactDigest: string | null;
  }>;
}

interface RuntimeResponse {
  applicationId: string;
  alias: string;
  siteId: string;
  specDigest: string;
  activeSpecDigest: string | null;
  desiredSpecDigest: string | null;
  ready: boolean;
  configuration: { missing: string[] };
  execution: {
    componentOrder: readonly string[];
    components: Record<string, RuntimeComponent>;
    services: Record<string, RuntimeService>;
    findings: Array<{ code: string; severity: string; message: string }>;
  };
  actual: RuntimeActual | null;
}

interface FleetSite {
  id: string;
  name: string;
  kind: 'home' | 'suitcase';
  revoked_at: string | null;
  credential_status: string;
  replicas: Array<{ app_id: string }>;
}

type ComponentHealthState = 'healthy' | 'degraded' | 'failed' | 'pending' | 'unknown';

interface ComponentHealthAnalysis {
  name: string;
  state: ComponentHealthState;
  ready: number;
  desired: number;
  minimumReady: number;
  criticalPath: boolean;
  rootCause: boolean;
  causedBy: string[];
  affectedDependants: string[];
}

interface RuntimeHealthAnalysis {
  components: Record<string, ComponentHealthAnalysis>;
  criticalPath: string[];
  rootCauses: string[];
  servingState: 'healthy' | 'degraded' | 'unavailable' | 'pending' | 'unknown';
}

export function RuntimeGraphPanel({ name }: { name: string }) {
  const [runtime, setRuntime] = useState<RuntimeResponse | null>(null);
  const [activeRuntime, setActiveRuntime] = useState<RuntimeResponse | null>(null);
  const [fleetSites, setFleetSites] = useState<FleetSite[]>([]);
  const [siteRuntimes, setSiteRuntimes] = useState<Record<string, RuntimeResponse>>({});
  const [siteSelections, setSiteSelections] = useState<Record<string, string>>({});
  const [actionNotices, setActionNotices] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [actionError, setActionError] = useState('');
  const [loading, setLoading] = useState(true);
  const [runningOperation, setRunningOperation] = useState('');

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    try {
      const headers = {
        'x-deploy-username': auth.username,
        'x-deploy-token': auth.token,
      };
      const [response, activeResponse, fleetResponse] = await Promise.all([
        fetch(`/api/deployments/${encodeURIComponent(name)}/application-runtime?revision=desired`, {
          headers,
        }),
        fetch(`/api/deployments/${encodeURIComponent(name)}/application-runtime?revision=active`, {
          headers,
        }),
        fetch('/api/fleet/topology', {
          headers: {
            ...headers,
          },
        }),
      ]);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load component runtime');
      const desiredRuntime = body as RuntimeResponse;
      setRuntime(desiredRuntime);
      setSiteRuntimes((current) => ({ ...current, [desiredRuntime.siteId]: desiredRuntime }));
      if (activeResponse.ok) {
        setActiveRuntime((await activeResponse.json()) as RuntimeResponse);
      } else {
        setActiveRuntime(null);
      }
      if (fleetResponse.ok) {
        const fleet = (await fleetResponse.json()) as { sites?: FleetSite[] };
        setFleetSites(fleet.sites ?? []);
      }
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoading(false);
    }
  }, [name]);

  const loadSiteRuntime = useCallback(
    async (siteId: string) => {
      const auth = getAuth();
      if (!auth) return;
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/application-runtime?revision=desired&siteId=${encodeURIComponent(siteId)}`,
        {
          headers: {
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Unable to load site component intent');
      setSiteRuntimes((current) => ({ ...current, [siteId]: body as RuntimeResponse }));
    },
    [name],
  );

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const activeEndpoints = useMemo(() => {
    const generations = new Map(
      (activeRuntime?.actual?.services ?? []).map((service) => [
        service.id,
        service.membershipGeneration,
      ]),
    );
    return (activeRuntime?.actual?.endpoints ?? []).filter(
      (endpoint) =>
        endpoint.readiness === 'ready' &&
        endpoint.admittedGeneration === generations.get(endpoint.serviceId),
    );
  }, [activeRuntime]);

  const healthAnalysis = useMemo(
    () => analyzeRuntimeHealth(runtime, activeRuntime),
    [activeRuntime, runtime],
  );

  const runProfileOperation = useCallback(
    async (
      componentName: string,
      operation: NonNullable<RuntimeComponent['profile']>['operations'][number],
    ) => {
      const auth = getAuth();
      if (!auth || !activeRuntime) return;
      const key = `${componentName}:${operation.id}`;
      const latestBackup = [...(activeRuntime.actual?.profileOperations ?? [])]
        .filter(
          (candidate) =>
            candidate.componentKey === componentName &&
            candidate.operation === 'logical-export' &&
            candidate.status === 'succeeded' &&
            candidate.sourceSpecDigest === activeRuntime.activeSpecDigest &&
            candidate.artifactDigest,
        )
        .sort((left, right) => (right.completedAt ?? 0) - (left.completedAt ?? 0))[0];
      if (operation.workflow === 'logical-restore' && !latestBackup?.artifactDigest) {
        setActionError('Create a successful logical backup before restoring.');
        return;
      }
      if (
        operation.destructive &&
        !window.confirm(
          `${operationLabel(operation)} ${componentName}? The active graph changes only after the restored database and every dependent component pass health checks.`,
        )
      ) {
        return;
      }
      setRunningOperation(key);
      setActionError('');
      try {
        const response = await fetch(
          `/api/deployments/${encodeURIComponent(name)}/components/${encodeURIComponent(componentName)}/operations/${encodeURIComponent(operation.id)}`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-deploy-username': auth.username,
              'x-deploy-token': auth.token,
            },
            body: JSON.stringify({
              ...(operation.workflow === 'logical-restore'
                ? { artifactDigest: latestBackup!.artifactDigest }
                : {}),
            }),
          },
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || 'Profile operation failed');
        await load();
      } catch (operationError) {
        setActionError(
          operationError instanceof Error ? operationError.message : String(operationError),
        );
      } finally {
        setRunningOperation('');
      }
    },
    [activeRuntime, load, name],
  );

  const runComponentAction = useCallback(
    async (
      componentName: string,
      action: 'restart' | 'scale' | 'scale-site' | 'reset-site' | 'replace',
      argument?: string,
    ) => {
      const auth = getAuth();
      if (!auth || !runtime) return;
      const component = runtime.execution.components[componentName];
      let instances: number | undefined;
      const siteAction = action === 'scale-site' || action === 'reset-site';
      let useDefault = action === 'reset-site';
      const siteId = siteAction ? argument : undefined;
      const instanceId = action === 'replace' ? argument : undefined;
      const selectedSiteComponent = siteId
        ? siteRuntimes[siteId]?.execution.components[componentName]
        : undefined;
      const previousInstances = siteAction
        ? (selectedSiteComponent?.desiredInstances ?? component.defaultInstances)
        : component.defaultInstances;
      if (action === 'scale' || action === 'scale-site') {
        const entered = window.prompt(
          action === 'scale'
            ? `Set the graph-wide default instance count for ${componentName}. This creates and activates a new immutable revision.`
            : `Set ${componentName} instances on ${siteName(siteId!, fleetSites)}. Its graph default is ${component.defaultInstances}.`,
          String(previousInstances),
        );
        if (entered === null) return;
        useDefault = action === 'scale-site' && entered.trim() === '';
        instances = useDefault ? undefined : Number(entered);
        if (
          !useDefault &&
          (!Number.isSafeInteger(instances) || instances! < 1 || instances! > 128)
        ) {
          setActionError('Instance count must be an integer from 1 through 128.');
          return;
        }
      }
      const effectiveInstances = useDefault ? component.defaultInstances : instances;
      if (
        (action === 'scale' || siteAction) &&
        effectiveInstances! < previousInstances &&
        !window.confirm(
          `Scale ${componentName} from ${previousInstances} to ${effectiveInstances}${siteId ? ` on ${siteName(siteId, fleetSites)}` : ''}? This removes fixed instance slots after the fleet safety gate passes.`,
        )
      ) {
        return;
      }
      if (
        action === 'replace' &&
        !window.confirm(
          `Replace ${componentName} instance ${instanceId}? Its stable slot remains while the container is recreated and health-gated.`,
        )
      ) {
        return;
      }
      const actionKey = `${componentName}:${action}:${argument ?? ''}`;
      setRunningOperation(actionKey);
      setActionError('');
      try {
        const suffix =
          action === 'replace'
            ? `instances/${encodeURIComponent(instanceId!)}/replace`
            : siteAction
              ? 'scale'
              : action;
        const response = await fetch(
          `/api/deployments/${encodeURIComponent(name)}/components/${encodeURIComponent(componentName)}/${suffix}`,
          {
            method: action === 'scale' || siteAction ? 'PUT' : 'POST',
            headers: {
              'content-type': 'application/json',
              'x-deploy-username': auth.username,
              'x-deploy-token': auth.token,
            },
            body:
              action === 'scale' || siteAction
                ? JSON.stringify({
                    instances: useDefault ? null : instances,
                    expectedParentDigest: runtime.desiredSpecDigest || runtime.activeSpecDigest,
                    confirmDestructive: effectiveInstances! < previousInstances,
                    scope: siteAction ? 'site' : 'default',
                    ...(siteAction ? { siteId, useDefault } : {}),
                  })
                : undefined,
          },
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || `Unable to ${action} ${componentName}`);
        if (siteAction && siteId) {
          const noticeKey = `${componentName}:${siteId}`;
          setActionNotices((current) => ({
            ...current,
            [noticeKey]: body.pendingTargetProcessing
              ? `Queued for ${siteName(siteId, fleetSites)}. It will apply when that Suitcase next syncs.`
              : `${siteName(siteId, fleetSites)} now uses ${body.instances} instance${body.instances === 1 ? '' : 's'}.`,
          }));
          await loadSiteRuntime(siteId);
        }
        await load();
      } catch (componentError) {
        setActionError(
          componentError instanceof Error ? componentError.message : String(componentError),
        );
      } finally {
        setRunningOperation('');
      }
    },
    [fleetSites, load, loadSiteRuntime, name, runtime, siteRuntimes],
  );

  if (loading) {
    return (
      <section className="card p-5" aria-label="Loading component runtime">
        <div className="h-3 w-36 animate-pulse rounded bg-bg-active motion-reduce:animate-none" />
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((item) => (
            <div
              key={item}
              className="h-28 animate-pulse rounded-lg bg-bg-active motion-reduce:animate-none"
            />
          ))}
        </div>
      </section>
    );
  }
  if (error || !runtime)
    return <ErrorBanner message={error || 'Component runtime is unavailable'} />;

  const actual = activeRuntime?.actual ?? null;
  const hasPendingRevision = runtime.activeSpecDigest !== runtime.specDigest;
  return (
    <section className="card overflow-hidden" aria-labelledby="runtime-graph-title">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow">Application graph</p>
            <span className={`badge ${runtime.ready ? 'badge-success' : 'badge-warning'}`}>
              {runtime.ready ? 'admitted' : 'blocked'}
            </span>
            {hasPendingRevision ? (
              <span className="badge badge-warning">pending activation</span>
            ) : null}
          </div>
          <h2 id="runtime-graph-title" className="mt-1 text-base font-semibold">
            Desired components on {siteName(runtime.siteId, fleetSites)}
          </h2>
          <p className="mt-1 text-xs text-text-secondary">
            Cards follow dependency order and name their exact upstream components. Counts compare
            active instances with the desired revision.
          </p>
        </div>
        <button type="button" className="btn btn-sm text-xs" onClick={() => void load()}>
          Refresh state
        </button>
      </header>

      <div className="p-4 sm:p-5">
        {actionError && <ErrorBanner message={actionError} />}
        {runtime.execution.componentOrder.length > 1 && (
          <CriticalPathSummary analysis={healthAnalysis} />
        )}
        <ol
          className={`relative grid gap-3 sm:grid-cols-2 xl:grid-cols-3 ${runtime.execution.componentOrder.length > 1 ? 'mt-4' : ''}`}
          aria-label="Component dependency order"
        >
          {runtime.execution.componentOrder.map((componentName) => {
            const component = runtime.execution.components[componentName];
            const componentHealth = healthAnalysis.components[componentName];
            const activeComponent = activeRuntime?.execution.components[componentName];
            const instances = (actual?.instances ?? []).filter(
              (instance) =>
                instance.componentKey === componentName && instance.status !== 'removed',
            );
            const ready = componentHealth?.ready ?? 0;
            const services = (actual?.services ?? []).filter(
              (service) => service.componentKey === componentName,
            );
            const siteOptions =
              runtime.siteId === 'coordinator'
                ? [
                    { id: 'coordinator', name: 'Home' },
                    ...fleetSites
                      .filter(
                        (site) =>
                          site.kind === 'suitcase' &&
                          !site.revoked_at &&
                          site.credential_status === 'active' &&
                          site.replicas.some((replica) => replica.app_id === runtime.applicationId),
                      )
                      .map((site) => ({ id: site.id, name: site.name })),
                  ]
                : [{ id: runtime.siteId, name: 'This Suitcase' }];
            const selectedSiteId =
              siteSelections[componentName] ?? siteOptions[0]?.id ?? runtime.siteId;
            const selectedSiteComponent =
              siteRuntimes[selectedSiteId]?.execution.components[componentName];
            const selectedSiteInstances =
              selectedSiteComponent?.desiredInstances ?? component.defaultInstances;
            const actionNotice = actionNotices[`${componentName}:${selectedSiteId}`];
            return (
              <li key={componentName} className="relative min-w-0">
                <article
                  className={`h-full rounded-lg border bg-bg/35 p-3.5 ${componentHealth?.rootCause ? 'border-danger/60 ring-1 ring-danger/15' : componentHealth?.causedBy.length ? 'border-warning/50' : 'border-border/80'}`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className="truncate text-sm font-semibold text-text">
                          {componentName}
                        </code>
                        <span className="badge bg-bg-active text-text-secondary">
                          {component.role}
                        </span>
                        {componentHealth?.rootCause && (
                          <span className="badge badge-danger">Root cause</span>
                        )}
                        {componentHealth?.state === 'degraded' && (
                          <span className="badge badge-warning">Degraded capacity</span>
                        )}
                        {componentHealth?.criticalPath &&
                          runtime.execution.componentOrder.length > 1 && (
                            <span className="badge bg-bg-active text-text-tertiary ring-1 ring-border">
                              Critical path
                            </span>
                          )}
                      </div>
                      <p
                        className="mt-1 truncate font-mono text-[10px] text-text-tertiary"
                        title={sourceLabel(component)}
                      >
                        {sourceLabel(component)}
                      </p>
                      <div
                        className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-text-tertiary"
                        aria-label={
                          component.dependencies.length
                            ? `${componentName} depends on ${component.dependencies.join(', ')}`
                            : `${componentName} has no component dependencies`
                        }
                      >
                        <span>{component.dependencies.length ? 'Depends on' : 'Graph root'}</span>
                        {component.dependencies.map((dependency) => (
                          <code
                            key={dependency}
                            className="rounded border border-border/80 bg-bg-active px-1.5 py-0.5 text-text-secondary"
                          >
                            ← {dependency}
                          </code>
                        ))}
                      </div>
                      {componentHealth?.causedBy.length ? (
                        <p className="mt-2 rounded-md bg-warning/8 px-2 py-1.5 text-[10px] text-warning">
                          Affected by {componentHealth.causedBy.join(', ')}
                        </p>
                      ) : null}
                      {componentHealth?.rootCause &&
                      componentHealth.affectedDependants.length > 0 ? (
                        <p className="mt-2 rounded-md bg-danger/8 px-2 py-1.5 text-[10px] text-danger">
                          Affects {componentHealth.affectedDependants.join(', ')}
                        </p>
                      ) : null}
                    </div>
                    <span
                      className={`font-mono text-xs ${componentHealth?.state === 'healthy' ? 'text-success' : componentHealth?.state === 'failed' ? 'text-danger' : 'text-warning'}`}
                      aria-label={`${componentName}: ${ready} of ${component.desiredInstances} instances ready, ${componentHealth?.state ?? 'unknown'}`}
                    >
                      {ready}/{component.desiredInstances}
                    </span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {instances.map((instance) => (
                      <span
                        key={instance.id}
                        className={`rounded-full border px-2 py-1 font-mono text-[9px] ${instanceTone(instance.status, instance.health)}`}
                        title={instance.containerName}
                      >
                        {slotLabel(instance.slotKey)} · {instance.health}
                      </span>
                    ))}
                    {instances.length === 0 && (
                      <span className="text-[10px] text-text-tertiary">
                        No materialized instances
                      </span>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-1.5 border-t border-border/70 pt-2.5">
                    <button
                      type="button"
                      className="btn btn-sm text-[10px]"
                      disabled={Boolean(runningOperation) || !actual || !activeComponent}
                      onClick={() => void runComponentAction(componentName, 'restart')}
                    >
                      {runningOperation === `${componentName}:restart:`
                        ? 'Restarting…'
                        : 'Restart component'}
                    </button>
                    {component.siteOverrides.allowed ? (
                      <div className="rounded-md border border-border/80 bg-bg-surface/40 p-1.5">
                        <div className="flex flex-wrap items-center gap-1">
                          <select
                            className="min-w-28 bg-transparent px-1 text-[10px] text-text-secondary outline-none"
                            aria-label={`Site count target for ${componentName}`}
                            value={selectedSiteId}
                            disabled={Boolean(runningOperation)}
                            onChange={(event) => {
                              const nextSiteId = event.target.value;
                              setSiteSelections((current) => ({
                                ...current,
                                [componentName]: nextSiteId,
                              }));
                              void loadSiteRuntime(nextSiteId).catch((siteError) =>
                                setActionError(
                                  siteError instanceof Error
                                    ? siteError.message
                                    : String(siteError),
                                ),
                              );
                            }}
                          >
                            {siteOptions.map((site) => (
                              <option key={site.id} value={site.id}>
                                {site.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="btn btn-sm text-[10px]"
                            disabled={Boolean(runningOperation)}
                            onClick={() =>
                              void runComponentAction(componentName, 'scale-site', selectedSiteId)
                            }
                            title={`Operational site count; allowed range ${component.siteOverrides.minimum}–${component.siteOverrides.maximum}`}
                          >
                            {runningOperation === `${componentName}:scale-site:${selectedSiteId}`
                              ? 'Sending…'
                              : 'Set site count'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm text-[10px]"
                            disabled={Boolean(runningOperation)}
                            onClick={() =>
                              void runComponentAction(componentName, 'reset-site', selectedSiteId)
                            }
                          >
                            {runningOperation === `${componentName}:reset-site:${selectedSiteId}`
                              ? 'Resetting…'
                              : 'Use graph default'}
                          </button>
                        </div>
                        <p className="px-1 pt-1 text-[9px] text-text-tertiary">
                          Site {selectedSiteInstances} · graph default {component.defaultInstances}{' '}
                          · allowed {component.siteOverrides.minimum}–
                          {component.siteOverrides.maximum}
                        </p>
                        {actionNotice ? (
                          <p className="max-w-72 px-1 pt-1 text-[9px] text-accent">
                            {actionNotice}
                          </p>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn-sm text-[10px]"
                      disabled={Boolean(runningOperation)}
                      onClick={() => void runComponentAction(componentName, 'scale')}
                      title={
                        component.siteOverrides.allowed
                          ? `Graph default ${component.defaultInstances}; site overrides ${component.siteOverrides.minimum}–${component.siteOverrides.maximum}`
                          : 'Change the graph-wide fixed instance count'
                      }
                    >
                      {runningOperation === `${componentName}:scale:` ? 'Scaling…' : 'Scale graph'}
                    </button>
                    {instances
                      .filter(
                        (instance) => instance.status !== 'ready' || instance.health !== 'healthy',
                      )
                      .map((instance) => (
                        <button
                          key={`replace-${instance.id}`}
                          type="button"
                          className="btn btn-sm text-[10px] text-warning"
                          disabled={Boolean(runningOperation)}
                          onClick={() =>
                            void runComponentAction(componentName, 'replace', instance.id)
                          }
                        >
                          {runningOperation === `${componentName}:replace:${instance.id}`
                            ? 'Replacing…'
                            : `Replace ${slotLabel(instance.slotKey)}`}
                        </button>
                      ))}
                  </div>
                  {services.length > 0 && (
                    <div className="mt-3 border-t border-border/70 pt-2.5">
                      {services.map((service) => {
                        const endpointCount = activeEndpoints.filter(
                          (endpoint) => endpoint.serviceId === service.id,
                        ).length;
                        return (
                          <p
                            key={service.id}
                            className="flex items-center justify-between gap-2 py-0.5 font-mono text-[10px] text-text-secondary"
                          >
                            <span>
                              {service.interfaceKey} · {service.protocol}:{service.containerPort}
                            </span>
                            <span className={endpointCount ? 'text-success' : 'text-text-tertiary'}>
                              {endpointCount} ready
                            </span>
                          </p>
                        );
                      })}
                    </div>
                  )}
                  {activeComponent?.profile && (
                    <div className="mt-3 border-t border-border/70 pt-2.5">
                      <p className="mb-2 font-mono text-[9px] uppercase tracking-wider text-text-tertiary">
                        {activeComponent.profile.profile}
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        {activeComponent.profile.operations
                          .filter((operation) => operationButtonVisible(operation.workflow))
                          .map((operation) => {
                            const operationKey = `${componentName}:${operation.id}`;
                            const binding = actual?.profileVolumeBindings.find(
                              (candidate) => candidate.componentKey === componentName,
                            );
                            const disabled =
                              Boolean(runningOperation) ||
                              (operation.workflow === 'logical-restore' &&
                                !(actual?.profileOperations ?? []).some(
                                  (candidate) =>
                                    candidate.componentKey === componentName &&
                                    candidate.operation === 'logical-export' &&
                                    candidate.status === 'succeeded' &&
                                    candidate.sourceSpecDigest ===
                                      activeRuntime?.activeSpecDigest &&
                                    candidate.artifactDigest,
                                )) ||
                              (operation.workflow === 'logical-major-upgrade' &&
                                runtime.desiredSpecDigest === runtime.activeSpecDigest) ||
                              (operation.workflow === 'logical-rollback' &&
                                !binding?.rollbackProviderVolume);
                            return (
                              <button
                                key={operation.id}
                                type="button"
                                className="btn btn-sm text-[10px]"
                                disabled={disabled}
                                onClick={() => void runProfileOperation(componentName, operation)}
                              >
                                {runningOperation === operationKey
                                  ? 'Running…'
                                  : operationLabel(operation)}
                              </button>
                            );
                          })}
                      </div>
                    </div>
                  )}
                </article>
              </li>
            );
          })}
        </ol>

        {runtime.execution.findings.some((finding) => finding.severity === 'error') && (
          <ul className="mt-4 rounded-lg border border-danger/25 bg-danger/8 p-3 text-xs text-danger">
            {runtime.execution.findings
              .filter((finding) => finding.severity === 'error')
              .map((finding) => (
                <li key={finding.code}>{finding.message}</li>
              ))}
          </ul>
        )}

        <details className="mt-4 rounded-lg border border-border/80 bg-bg/20">
          <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium hover:text-accent sm:px-4">
            Inspect instances, jobs, and volume attachments
          </summary>
          <div className="space-y-5 border-t border-border/80 p-3 sm:p-4">
            <RuntimeTree
              runtime={{ ...runtime, actual }}
              activeEndpoints={activeEndpoints}
              healthAnalysis={healthAnalysis}
            />
            <StateTable
              title="Lifecycle jobs"
              columns={['Job', 'Component', 'Scope', 'Status', 'Attempts']}
              rows={(actual?.jobs ?? []).map((job) => [
                job.jobKey,
                job.componentKey,
                job.scope,
                job.status,
                String(job.attempts),
              ])}
              empty="No lifecycle jobs have run on this site."
            />
            <StateTable
              title="Volume attachments"
              columns={['Resource', 'Component', 'Mount', 'Provider', 'State']}
              rows={(actual?.volumes ?? []).map((volume) => [
                volume.resourceKey,
                volume.componentKey,
                `${volume.mountPath}${volume.readOnly ? ' (read only)' : ''}`,
                volume.providerVolume,
                volume.state,
              ])}
              empty="No component volumes are attached on this site."
            />
            <StateTable
              title="Profile backup, restore, and upgrade evidence"
              columns={['Operation', 'Component', 'Status', 'Artifact', 'Verification']}
              rows={(actual?.profileOperations ?? []).map((operation) => [
                operation.operation,
                operation.componentKey,
                operation.status,
                operation.artifactDigest ?? '—',
                operation.verification ?? '—',
              ])}
              empty="No profile lifecycle operations have run on this site."
            />
            <StateTable
              title="Profile volume activation"
              columns={['Component', 'Resource', 'Active provider', 'Rollback provider']}
              rows={(actual?.profileVolumeBindings ?? []).map((binding) => [
                binding.componentKey,
                binding.resourceKey,
                binding.activeProviderVolume,
                binding.rollbackProviderVolume ?? '—',
              ])}
              empty="No profile-owned provider transition has been activated."
            />
          </div>
        </details>
      </div>
    </section>
  );
}

function CriticalPathSummary({ analysis }: { analysis: RuntimeHealthAnalysis }) {
  const stateLabel = {
    healthy: 'Serving path healthy',
    degraded: 'Serving with reduced capacity',
    unavailable: 'Serving path unavailable',
    pending: 'Serving change pending',
    unknown: 'Serving health unknown',
  }[analysis.servingState];
  const tone =
    analysis.servingState === 'healthy'
      ? 'border-success/30 bg-success/6'
      : analysis.servingState === 'unavailable'
        ? 'border-danger/35 bg-danger/8'
        : 'border-warning/35 bg-warning/7';
  const labelTone =
    analysis.servingState === 'healthy'
      ? 'text-success'
      : analysis.servingState === 'unavailable'
        ? 'text-danger'
        : 'text-warning';

  return (
    <section
      className={`rounded-lg border p-3 sm:p-4 ${tone}`}
      aria-labelledby="critical-path-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">Critical path</p>
          <h3 id="critical-path-title" className={`mt-1 text-sm font-semibold ${labelTone}`}>
            {stateLabel}
          </h3>
          {analysis.criticalPath.length > 0 ? (
            <div
              className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-text-secondary"
              aria-label={`Required serving closure: ${analysis.criticalPath.join(', ')}`}
            >
              <span className="text-text-tertiary">Required serving closure</span>
              {analysis.criticalPath.map((name) => (
                <code key={name} className="rounded border border-border/80 bg-bg/60 px-1.5 py-0.5">
                  {name}
                </code>
              ))}
            </div>
          ) : (
            <p className="mt-1 text-[11px] text-text-secondary">
              No serving component is declared.
            </p>
          )}
        </div>
        {analysis.rootCauses.length === 0 ? (
          <span className="badge badge-success">No root failures</span>
        ) : (
          <span className="badge badge-danger">
            {analysis.rootCauses.length} root{' '}
            {analysis.rootCauses.length === 1 ? 'failure' : 'failures'}
          </span>
        )}
      </div>

      {analysis.rootCauses.length > 0 && (
        <ul className="mt-3 space-y-2" aria-label="Runtime root causes">
          {analysis.rootCauses.map((name) => {
            const component = analysis.components[name];
            return (
              <li key={name} className="rounded-md border border-danger/20 bg-bg/45 px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <code className="text-xs font-semibold text-danger">{name}</code>
                  <span className="text-[10px] text-text-secondary">
                    {component.ready}/{component.desired} ready; requires {component.minimumReady}
                  </span>
                </div>
                <p className="mt-1 text-[11px] text-text-secondary">
                  {component.affectedDependants.length
                    ? `Affected dependants: ${component.affectedDependants.join(', ')}.`
                    : 'No other component depends on this runtime.'}
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function RuntimeTree({
  runtime,
  activeEndpoints,
  healthAnalysis,
}: {
  runtime: RuntimeResponse;
  activeEndpoints: RuntimeActual['endpoints'];
  healthAnalysis: RuntimeHealthAnalysis;
}) {
  return (
    <section aria-labelledby="runtime-tree-title">
      <h3 id="runtime-tree-title" className="eyebrow mb-2">
        Accessible component tree
      </h3>
      <ul className="space-y-2 text-xs">
        {runtime.execution.componentOrder.map((name) => {
          const component = runtime.execution.components[name];
          const instances = (runtime.actual?.instances ?? []).filter(
            (item) => item.componentKey === name && item.status !== 'removed',
          );
          const services = Object.values(runtime.execution.services).filter(
            (item) => item.component === name,
          );
          const health = healthAnalysis.components[name];
          return (
            <li key={name} className="rounded-md border border-border/70 px-3 py-2.5">
              <strong>{name}</strong>
              <span className="ml-2 text-text-tertiary">
                {component.dependencies.length
                  ? `depends on ${component.dependencies.join(', ')}`
                  : 'root component'}
              </span>
              <span className="ml-2 text-text-tertiary">
                {health?.rootCause
                  ? `root failure affecting ${health.affectedDependants.join(', ') || 'no dependants'}`
                  : health?.causedBy.length
                    ? `affected by ${health.causedBy.join(', ')}`
                    : (health?.state ?? 'unknown')}
              </span>
              <ul className="mt-2 space-y-1 border-l border-border pl-3 text-text-secondary">
                {instances.map((instance) => (
                  <li key={instance.id}>
                    Instance {slotLabel(instance.slotKey)}: {instance.status}, {instance.health}
                  </li>
                ))}
                {services.map((service) => (
                  <li key={service.id}>
                    Service {service.interface}:{' '}
                    {activeEndpoints.filter((item) => item.serviceId === service.id).length} ready
                    endpoint(s)
                  </li>
                ))}
                {Object.entries(component.mounts).map(([path, mount]) => (
                  <li key={path}>
                    Volume {mount.resource} at {path}
                    {mount.readOnly ? ', read only' : ''}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StateTable({
  title,
  columns,
  rows,
  empty,
}: {
  title: string;
  columns: string[];
  rows: string[][];
  empty: string;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border/80" aria-label={title}>
      <h3 className="border-b border-border/80 px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
        {title}
      </h3>
      {rows.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[620px] text-left text-xs">
            <thead className="bg-bg-surface/60 text-[10px] uppercase tracking-wider text-text-tertiary">
              <tr>
                {columns.map((column) => (
                  <th key={column} className="px-3 py-2 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {rows.map((row, rowIndex) => (
                <tr key={`${row[0]}-${rowIndex}`}>
                  {row.map((cell, cellIndex) => (
                    <td
                      key={`${columns[cellIndex]}-${cellIndex}`}
                      className="max-w-64 break-all px-3 py-2 font-mono text-[10px] text-text-secondary"
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="px-3 py-4 text-xs text-text-tertiary">{empty}</p>
      )}
    </section>
  );
}

function analyzeRuntimeHealth(
  desired: RuntimeResponse | null,
  active: RuntimeResponse | null,
): RuntimeHealthAnalysis {
  if (!desired) {
    return { components: {}, criticalPath: [], rootCauses: [], servingState: 'unknown' };
  }

  const names = desired.execution.componentOrder.filter((name) =>
    Object.hasOwn(desired.execution.components, name),
  );
  const dependants = new Map(names.map((name) => [name, [] as string[]]));
  for (const name of names) {
    for (const dependency of desired.execution.components[name].dependencies) {
      dependants.get(dependency)?.push(name);
    }
  }

  const webEntries = names.filter(
    (name) =>
      desired.execution.components[name].role === 'web' &&
      !(dependants.get(name) ?? []).some(
        (candidate) => desired.execution.components[candidate]?.role === 'web',
      ),
  );
  const entries =
    webEntries.length > 0
      ? webEntries
      : names.filter((name) => (dependants.get(name) ?? []).length === 0);
  const criticalNames = new Set<string>();
  const addDependencies = (name: string) => {
    if (criticalNames.has(name)) return;
    criticalNames.add(name);
    for (const dependency of desired.execution.components[name]?.dependencies ?? []) {
      addDependencies(dependency);
    }
  };
  for (const entry of entries) addDependencies(entry);

  const activeComponents = new Set(Object.keys(active?.execution.components ?? {}));
  const actual = active?.actual ?? null;
  const components: Record<string, ComponentHealthAnalysis> = {};
  for (const name of names) {
    const component = desired.execution.components[name];
    const ready = (actual?.instances ?? []).filter(
      (instance) =>
        instance.componentKey === name &&
        instance.status === 'ready' &&
        instance.health === 'healthy',
    ).length;
    let state: ComponentHealthState;
    if (!active || !actual) state = 'unknown';
    else if (!activeComponents.has(name)) state = 'pending';
    else if (ready < component.minimumReady) state = 'failed';
    else if (ready < component.desiredInstances) state = 'degraded';
    else state = 'healthy';
    components[name] = {
      name,
      state,
      ready,
      desired: component.desiredInstances,
      minimumReady: component.minimumReady,
      criticalPath: criticalNames.has(name),
      rootCause: false,
      causedBy: [],
      affectedDependants: [],
    };
  }

  const hasFailedDependency = (name: string, seen = new Set<string>()): boolean => {
    if (seen.has(name)) return false;
    seen.add(name);
    return (desired.execution.components[name]?.dependencies ?? []).some(
      (dependency) =>
        components[dependency]?.state === 'failed' || hasFailedDependency(dependency, seen),
    );
  };
  const rootCauses = names.filter(
    (name) => components[name].state === 'failed' && !hasFailedDependency(name),
  );

  const dependantClosure = (root: string): string[] => {
    const affected = new Set<string>();
    const visit = (name: string) => {
      for (const dependant of dependants.get(name) ?? []) {
        if (affected.has(dependant)) continue;
        affected.add(dependant);
        visit(dependant);
      }
    };
    visit(root);
    return names.filter((name) => affected.has(name));
  };
  const closures = new Map(rootCauses.map((name) => [name, dependantClosure(name)]));
  for (const root of rootCauses) {
    components[root].rootCause = true;
    components[root].affectedDependants = closures.get(root) ?? [];
  }
  for (const name of names) {
    components[name].causedBy = rootCauses.filter(
      (root) => root !== name && closures.get(root)?.includes(name),
    );
  }

  const criticalComponents = names.filter((name) => criticalNames.has(name));
  let servingState: RuntimeHealthAnalysis['servingState'];
  if (!active || !actual) servingState = 'unknown';
  else if (criticalComponents.some((name) => components[name].state === 'failed'))
    servingState = 'unavailable';
  else if (criticalComponents.some((name) => components[name].state === 'degraded'))
    servingState = 'degraded';
  else if (criticalComponents.some((name) => components[name].state === 'pending'))
    servingState = 'pending';
  else servingState = 'healthy';

  return {
    components,
    criticalPath: [...names].reverse().filter((name) => criticalNames.has(name)),
    rootCauses,
    servingState,
  };
}

function sourceLabel(component: RuntimeComponent): string {
  return component.source.kind === 'image'
    ? component.source.reference
    : `build ${component.source.context}`;
}

function slotLabel(slot: string): string {
  return slot.split('/').at(-1) ?? slot;
}

function siteName(siteId: string, sites: FleetSite[]): string {
  if (siteId === 'coordinator') return 'Home';
  return sites.find((site) => site.id === siteId)?.name ?? siteId;
}

function instanceTone(status: string, health: string): string {
  if (status === 'ready' && health === 'healthy')
    return 'border-success/30 bg-success/8 text-success';
  if (status === 'failed' || health === 'unhealthy')
    return 'border-danger/30 bg-danger/8 text-danger';
  return 'border-warning/30 bg-warning/8 text-warning';
}

function operationButtonVisible(workflow: string | undefined): boolean {
  return (
    workflow === 'logical-backup' ||
    workflow === 'logical-restore' ||
    workflow === 'logical-major-upgrade' ||
    workflow === 'logical-rollback'
  );
}

function operationLabel(
  operation: NonNullable<RuntimeComponent['profile']>['operations'][number],
): string {
  switch (operation.workflow) {
    case 'logical-backup':
      return 'Back up';
    case 'logical-restore':
      return 'Restore latest';
    case 'logical-major-upgrade':
      return 'Upgrade database';
    case 'logical-rollback':
      return 'Roll back';
    default:
      return operation.id;
  }
}
