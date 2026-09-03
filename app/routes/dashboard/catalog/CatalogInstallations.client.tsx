'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  CatalogBlueprintRelease,
  CatalogInstallation,
  CatalogOperation,
  CatalogOperationPlan,
  CatalogRecoveryPoint,
} from '../../../../server/catalog/types.ts';
import { getAuth } from '../detail/shared.tsx';

export default function CatalogInstallationsClient() {
  const [installations, setInstallations] = useState<CatalogInstallation[]>([]);
  const [releases, setReleases] = useState<
    Array<{ id: string; release: string; upgradeFrom: string[] }>
  >([]);
  const [busyId, setBusyId] = useState('');
  const [pendingRecoveries, setPendingRecoveries] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [installationBody, catalogBody] = await Promise.all([
        request<{ installations: CatalogInstallation[] }>('/api/catalog/installations'),
        request<{
          releases: Array<{ id: string; release: string; upgradeFrom: string[] }>;
        }>('/api/catalog'),
      ]);
      setInstallations(installationBody.installations);
      setReleases(catalogBody.releases);
    } catch (refreshError) {
      setError((refreshError as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (
      !installations.some((item) =>
        ['installing', 'upgrading', 'rolling-back', 'uninstalling'].includes(item.status),
      )
    )
      return;
    const timer = window.setInterval(() => void refresh(), 1_500);
    return () => window.clearInterval(timer);
  }, [installations, refresh]);

  useEffect(() => {
    if (Object.keys(pendingRecoveries).length === 0) return;
    const timer = window.setInterval(() => {
      for (const [installationId, recoveryPointId] of Object.entries(pendingRecoveries)) {
        void request<{ recoveryPoints: CatalogRecoveryPoint[] }>(
          `/api/catalog/installations/${installationId}`,
        )
          .then((detail) => {
            const point = detail.recoveryPoints.find(
              (candidate) => candidate.id === recoveryPointId,
            );
            if (!point || point.status === 'pending') return;
            setPendingRecoveries((current) => {
              const next = { ...current };
              delete next[installationId];
              return next;
            });
            if (point.status === 'verified') {
              setMessage(`Recovery point verified for ${point.applicationName}.`);
            } else {
              setError(point.verification || `Recovery point failed for ${point.applicationName}.`);
            }
          })
          .catch((pollError) => setError((pollError as Error).message));
      }
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [pendingRecoveries]);

  async function act(
    installation: CatalogInstallation,
    action:
      | 'retry'
      | 'recovery'
      | 'upgrade'
      | 'rollback'
      | 'detach'
      | 'derive'
      | 'retain'
      | 'delete',
  ) {
    if (
      (action === 'retain' || action === 'delete') &&
      !window.confirm(
        action === 'retain'
          ? `Uninstall ${installation.applicationName} and retain its volumes?`
          : `Permanently delete ${installation.applicationName} runtime and volumes using its latest verified recovery point?`,
      )
    )
      return;
    setBusyId(installation.id);
    setError('');
    setMessage('');
    try {
      if (action === 'retry') {
        await request(`/api/catalog/installations/${installation.id}/retry`, {
          expectedRevision: installation.revision,
        });
        setMessage(`Retry started for ${installation.applicationName}.`);
      } else if (action === 'recovery') {
        const point = await request<CatalogRecoveryPoint>(
          `/api/catalog/installations/${installation.id}/recovery-points`,
          {},
        );
        if (point.status === 'pending') {
          setPendingRecoveries((current) => ({ ...current, [installation.id]: point.id }));
          setMessage(`Recovery point requested from ${installation.siteId}.`);
        } else {
          setMessage(`Recovery point verified for ${installation.applicationName}.`);
        }
      } else if (action === 'upgrade') {
        const target = upgradeTarget(releases, installation);
        if (!target) throw new Error('No signed successor release accepts this installation.');
        const detail = await request<{ release: CatalogBlueprintRelease }>(
          `/api/catalog/${encodeURIComponent(installation.blueprintId)}/${encodeURIComponent(target.release)}`,
        );
        const answers: Record<string, unknown> = {};
        for (const question of detail.release.questions) {
          const value = window.prompt(
            `${question.label}${question.required ? ' (required)' : ''}\n${question.help || ''}`,
          );
          if (value === null) throw new Error('Upgrade cancelled before any runtime change.');
          if (question.required && value === '') {
            throw new Error(`${question.label} is required for this release.`);
          }
          if (value !== '') answers[question.key] = value;
        }
        const plan = await request<CatalogOperationPlan>(
          `/api/catalog/installations/${installation.id}/upgrade-plan`,
          {
            toRelease: target.release,
            targetSiteId: installation.siteId,
            answers,
          },
        );
        if (!plan.ready) {
          throw new Error(plan.blockers.map((blocker) => blocker.summary).join(' '));
        }
        if (
          !window.confirm(
            `Upgrade ${installation.applicationName} to ${target.release}? deploy.local will verify a recovery point, run declared migrations, health-check the new graph, and retain rollback state.`,
          )
        )
          return;
        const installationDetail = await request<{ recoveryPoints: CatalogRecoveryPoint[] }>(
          `/api/catalog/installations/${installation.id}`,
        );
        let recovery = installationDetail.recoveryPoints
          .filter((point) => point.status === 'verified' && point.release === installation.release)
          .at(-1);
        if (!recovery) {
          setMessage(
            `Creating and verifying a recovery point for ${installation.applicationName}…`,
          );
          const requested = await request<CatalogRecoveryPoint>(
            `/api/catalog/installations/${installation.id}/recovery-points`,
            {},
          );
          recovery =
            requested.status === 'verified'
              ? requested
              : await waitForVerifiedRecovery(installation.id, requested.id);
        }
        await request(`/api/catalog/installations/${installation.id}/upgrade`, {
          toRelease: target.release,
          targetSiteId: installation.siteId,
          expectedRevision: installation.revision,
          recoveryPointId: recovery.id,
          answers,
        });
        setMessage(`Upgrade to ${target.release} started for ${installation.applicationName}.`);
      } else if (action === 'rollback') {
        const detail = await request<{ recoveryPoints: CatalogRecoveryPoint[] }>(
          `/api/catalog/installations/${installation.id}`,
        );
        const candidates = detail.recoveryPoints.filter((point) => point.status === 'verified');
        const point =
          candidates.findLast((candidate) => candidate.release !== installation.release) ||
          candidates.at(-1);
        if (!point) throw new Error('Create a verified recovery point before rollback.');
        await request(`/api/catalog/installations/${installation.id}/rollback`, {
          recoveryPointId: point.id,
          expectedRevision: installation.revision,
        });
        setMessage(`Rollback started for ${installation.applicationName} using ${point.release}.`);
      } else if (action === 'detach' || action === 'derive') {
        const localBlueprintId =
          action === 'derive'
            ? window.prompt('Local blueprint ID', `${installation.blueprintId}.local`)
            : undefined;
        if (action === 'derive' && !localBlueprintId) return;
        await request(`/api/catalog/installations/${installation.id}/${action}`, {
          expectedRevision: installation.revision,
          ...(localBlueprintId ? { localBlueprintId } : {}),
        });
        setMessage(
          `${installation.applicationName} is now ${action === 'derive' ? `derived as ${localBlueprintId}` : 'detached from curated upgrades'}.`,
        );
      } else {
        let recoveryPointId: string | undefined;
        if (action === 'delete') {
          const detail = await request<{ recoveryPoints: CatalogRecoveryPoint[] }>(
            `/api/catalog/installations/${installation.id}`,
          );
          recoveryPointId = detail.recoveryPoints
            .filter((point) => point.status === 'verified')
            .at(-1)?.id;
          if (!recoveryPointId)
            throw new Error('Create a verified recovery point before deleting data.');
        }
        const result = await request<{
          installation: CatalogInstallation;
          operation: CatalogOperation;
        }>(`/api/catalog/installations/${installation.id}/uninstall`, {
          retainData: action === 'retain',
          expectedRevision: installation.revision,
          ...(recoveryPointId ? { recoveryPointId } : {}),
        });
        setMessage(
          result.operation.status === 'running'
            ? `Uninstall queued for ${installation.applicationName} on ${installation.siteId}.`
            : `${installation.applicationName} uninstalled with data ${action === 'retain' ? 'retained' : 'deleted'}.`,
        );
      }
      await refresh();
    } catch (actionError) {
      setError((actionError as Error).message);
    } finally {
      setBusyId('');
    }
  }

  if (installations.length === 0 && !error) return null;
  return (
    <section className="card overflow-hidden" aria-labelledby="catalog-installations-title">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <p className="eyebrow">Durable operations</p>
        <h2 id="catalog-installations-title" className="mt-1 text-sm font-semibold text-text">
          Catalog installations
        </h2>
        <p className="mt-1 text-xs text-text-tertiary">
          Running intent survives restart. Delete-data stays gated on a verified physical recovery
          point.
        </p>
      </header>
      <ul className="divide-y divide-border">
        {installations.map((installation) => {
          const running = ['installing', 'upgrading', 'rolling-back', 'uninstalling'].includes(
            installation.status,
          );
          const successor = upgradeTarget(releases, installation);
          return (
            <li key={installation.id} className="px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-medium text-text">
                      {installation.applicationName}
                    </h3>
                    <span
                      className={`badge ${installation.status === 'healthy' ? 'badge-success' : installation.status === 'failed' ? 'badge-danger' : 'badge-warning'}`}
                    >
                      {installation.status}
                    </span>
                    {running && (
                      <span className="text-[10px] text-text-tertiary">operation in progress…</span>
                    )}
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-text-tertiary">
                    {installation.blueprintId}@{installation.release} · {installation.siteId} ·
                    revision {installation.revision}
                  </p>
                  {installation.failure && (
                    <p className="mt-2 text-xs text-danger">{installation.failure}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {installation.status === 'failed' && (
                    <button
                      className="btn btn-sm"
                      disabled={busyId === installation.id}
                      onClick={() => void act(installation, 'retry')}
                    >
                      Retry
                    </button>
                  )}
                  {installation.status === 'healthy' && installation.mode === 'managed' && (
                    <>
                      {successor && (
                        <button
                          className="btn btn-sm btn-primary"
                          disabled={busyId === installation.id}
                          onClick={() => void act(installation, 'upgrade')}
                        >
                          Upgrade to {successor.release}
                        </button>
                      )}
                      <button
                        className="btn btn-sm"
                        disabled={
                          busyId === installation.id ||
                          pendingRecoveries[installation.id] !== undefined
                        }
                        onClick={() => void act(installation, 'recovery')}
                      >
                        {pendingRecoveries[installation.id]
                          ? 'Recovery point pending…'
                          : 'Create recovery point'}
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busyId === installation.id}
                        onClick={() => void act(installation, 'rollback')}
                      >
                        Rollback from recovery
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busyId === installation.id}
                        onClick={() => void act(installation, 'detach')}
                      >
                        Detach
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busyId === installation.id}
                        onClick={() => void act(installation, 'derive')}
                      >
                        Derive local blueprint
                      </button>
                      <button
                        className="btn btn-sm"
                        disabled={busyId === installation.id}
                        onClick={() => void act(installation, 'retain')}
                      >
                        Uninstall · retain data
                      </button>
                      <button
                        className="btn btn-sm text-danger"
                        disabled={busyId === installation.id}
                        onClick={() => void act(installation, 'delete')}
                      >
                        Uninstall · delete data
                      </button>
                    </>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {(message || error) && (
        <div className="border-t border-border px-4 py-3 text-xs sm:px-5" aria-live="polite">
          <p className={error ? 'text-danger' : 'text-success'}>{error || message}</p>
        </div>
      )}
    </section>
  );
}

function upgradeTarget(
  releases: Array<{ id: string; release: string; upgradeFrom: string[] }>,
  installation: CatalogInstallation,
) {
  return releases
    .filter(
      (release) =>
        release.id === installation.blueprintId &&
        release.upgradeFrom.includes(installation.release),
    )
    .sort((left, right) => left.release.localeCompare(right.release))
    .at(-1);
}

async function waitForVerifiedRecovery(
  installationId: string,
  recoveryPointId: string,
): Promise<CatalogRecoveryPoint> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
    const detail = await request<{ recoveryPoints: CatalogRecoveryPoint[] }>(
      `/api/catalog/installations/${installationId}`,
    );
    const point = detail.recoveryPoints.find((candidate) => candidate.id === recoveryPointId);
    if (point?.status === 'verified') return point;
    if (point?.status === 'failed') {
      throw new Error(point.verification || 'Recovery point verification failed.');
    }
  }
  throw new Error(
    'Recovery point is still pending. It remains durable; retry the upgrade shortly.',
  );
}

async function request<T = { installation: CatalogInstallation; operation: CatalogOperation }>(
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = getAuth();
  if (!auth) throw new Error('Authenticate again to manage catalog applications.');
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      'x-deploy-username': auth.username,
      'x-deploy-token': auth.token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(payload.error || `Catalog request failed (${response.status})`);
  return payload;
}
