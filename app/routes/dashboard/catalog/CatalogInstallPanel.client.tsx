'use client';
import { LegacyIconButton as IconButton } from '@/components/ui';

import { Select } from '@/components/ui';

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-flight-router/client';
import { TextField, LoadingState, ErrorBanner, EmptyState } from '../../../components/ui';
import type {
  CatalogInstallation,
  CatalogOperation,
  CatalogPreflightResult,
  CatalogTargetProfile,
} from '../../../../server/catalog/types.ts';
import { getAuth } from '../detail/shared.tsx';
import type { CatalogUiRelease } from './ui-types.ts';

type InstallResult = { installation: CatalogInstallation; operation: CatalogOperation };

export default function CatalogInstallPanel({ release }: { release: CatalogUiRelease }) {
  const [targets, setTargets] = useState<CatalogTargetProfile[]>([]);
  const [computerNames, setComputerNames] = useState<Record<string, string>>({});
  const [targetsLoading, setTargetsLoading] = useState(true);
  const [targetsError, setTargetsError] = useState('');
  const [targetSiteId, setTargetSiteId] = useState('');
  const [applicationName, setApplicationName] = useState(release.graph.metadata.name || release.id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<CatalogPreflightResult | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadTargets = useCallback(async () => {
    setTargetsLoading(true);
    setTargetsError('');
    try {
      const body = await catalogRequest<{ targets: CatalogTargetProfile[] }>(
        '/api/catalog/targets',
      );
      // Names come from the same inventory as Computers; capability IDs are not names.
      const inventory = await catalogRequest<{
        nodes: Array<{ id: string; name: string; revokedAt: string | null }>;
      }>('/api/nodes').catch(() => null);
      const available = inventory
        ? body.targets.filter((target) =>
            inventory.nodes.some((node) => node.id === target.siteId && !node.revokedAt),
          )
        : body.targets;
      setTargets(available);
      setComputerNames(
        Object.fromEntries((inventory?.nodes || []).map((node) => [node.id, node.name])),
      );
      setTargetSiteId((current) =>
        available.some((target) => target.siteId === current)
          ? current
          : available.find((target) => target.siteId === 'coordinator')?.siteId ||
            available[0]?.siteId ||
            '',
      );
    } catch (loadError) {
      setTargetsError((loadError as Error).message);
    } finally {
      setTargetsLoading(false);
    }
  }, []);
  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  useEffect(() => {
    if (
      !result ||
      !['installing', 'upgrading', 'rolling-back', 'uninstalling'].includes(
        result.installation.status,
      )
    )
      return;
    const timer = window.setInterval(() => {
      void catalogRequest<{
        installation: CatalogInstallation;
        operations: CatalogOperation[];
      }>(`/api/catalog/installations/${encodeURIComponent(result.installation.id)}`)
        .then((body) => {
          const operation =
            body.operations.find((candidate) => candidate.id === result.operation.id) ||
            result.operation;
          setResult({ installation: body.installation, operation });
        })
        .catch((pollError) => setError((pollError as Error).message));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [result]);

  async function submit(action: 'preflight' | 'install') {
    setBusy(true);
    setError('');
    try {
      const payload = { applicationName, targetSiteId, answers };
      if (action === 'preflight') {
        setPreflight(
          await catalogRequest<CatalogPreflightResult>(
            `/api/catalog/${encodeURIComponent(release.id)}/${encodeURIComponent(release.release)}/preflight`,
            payload,
          ),
        );
      } else {
        setResult(
          await catalogRequest<InstallResult>(
            `/api/catalog/${encodeURIComponent(release.id)}/${encodeURIComponent(release.release)}/install`,
            payload,
          ),
        );
      }
    } catch (submitError) {
      setError((submitError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    if (!result) return;
    setBusy(true);
    setError('');
    try {
      setResult(
        await catalogRequest<InstallResult>(
          `/api/catalog/installations/${encodeURIComponent(result.installation.id)}/retry`,
          { expectedRevision: result.installation.revision, answers },
        ),
      );
    } catch (retryError) {
      setError((retryError as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card overflow-hidden" aria-labelledby="catalog-install-title">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <h2 id="catalog-install-title" className="mt-1 text-sm font-semibold text-text">
          Install {release.name}
        </h2>
        <p className="mt-1 text-xs text-text-tertiary">
          Choose a computer and check its requirements before installing.
        </p>
      </header>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-2">
          <TextField
            label="Application name"
            value={applicationName}
            onChange={(event) => {
              setApplicationName(event.target.value);
              setPreflight(null);
            }}
          />
          <label>
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">
              Deployment target
            </span>
            <Select
              className="input input-sm"
              value={targetSiteId}
              disabled={targetsLoading || !targets.length}
              onChange={(event) => {
                setTargetSiteId(event.target.value);
                setPreflight(null);
              }}
            >
              {!targets.length && (
                <option value="">
                  {targetsLoading
                    ? 'Loading computers…'
                    : targetsError
                      ? 'Computers unavailable'
                      : 'No deployment computers'}
                </option>
              )}
              {targets.map((target) => (
                <option key={target.siteId} value={target.siteId}>
                  {computerNames[target.siteId] ||
                    (target.siteId === 'coordinator' ? 'Coordinator' : target.siteId)}{' '}
                  · {target.operatingSystem}/{target.architecture} ·{' '}
                  {Math.round(target.memoryMiB / 1024)} GiB{!target.online ? ' · Offline' : ''}
                </option>
              ))}
            </Select>
          </label>
        </div>
        {targetsLoading ? (
          <LoadingState message="Loading deployment computers…" />
        ) : targetsError ? (
          <ErrorBanner
            message={targetsError}
            action={
              <IconButton
                icon="refresh"
                label="Retry computers"
                onClick={() => void loadTargets()}
              />
            }
          />
        ) : !targets.length ? (
          <EmptyState
            title="No deployment computers available"
            description="Connect a deployment computer, then refresh this list."
            action={
              <>
                <Link to="/dashboard/nodes">Connect a computer</Link>
                <IconButton
                  icon="refresh"
                  label="Refresh computers"
                  onClick={() => void loadTargets()}
                />
              </>
            }
          />
        ) : null}
        {release.questions.length > 0 && (
          <div className="grid gap-3 md:grid-cols-2">
            {release.questions.map((question) => (
              <label key={question.key}>
                <span className="mb-1.5 block text-xs font-medium text-text-secondary">
                  {question.label}
                </span>
                <input
                  className="input input-sm"
                  type={question.secret ? 'password' : 'text'}
                  required={question.required}
                  value={answers[question.key] || ''}
                  onChange={(event) => {
                    setAnswers((current) => ({ ...current, [question.key]: event.target.value }));
                    setPreflight(null);
                  }}
                  autoComplete="new-password"
                />
                {question.help && (
                  <span className="mt-1 block text-xs text-text-tertiary">{question.help}</span>
                )}
              </label>
            ))}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy || !targetSiteId || !applicationName}
            onClick={() => void submit('preflight')}
          >
            {busy ? 'Checking…' : 'Check requirements'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !preflight?.ready}
            onClick={() => void submit('install')}
          >
            Install application
          </button>
        </div>
        {preflight && (
          <div
            className={`rounded-lg border px-3 py-3 ${preflight.ready ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}`}
          >
            <p className="text-xs font-medium text-text">
              {preflight.ready ? 'Ready to install' : 'Requirements need attention'}
            </p>
            <ul className="mt-2 space-y-1 text-xs text-text-secondary">
              {preflight.findings.map((finding) => (
                <li key={finding.id}>
                  [{finding.severity}] {finding.summary}
                </li>
              ))}
            </ul>
          </div>
        )}
        {result && (
          <div className="rounded-lg border border-border bg-bg/40 px-3 py-3" aria-live="polite">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={`badge ${result.installation.status === 'healthy' ? 'badge-success' : result.installation.status === 'failed' ? 'badge-danger' : 'badge-warning'}`}
              >
                {result.installation.status}
              </span>
              <span className="font-mono text-xs text-text-tertiary">
                attempt {result.operation.attempt} · {result.operation.status}
              </span>
              {result.installation.status === 'failed' && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => void retry()}
                >
                  Retry exact operation
                </button>
              )}
            </div>
            {result.installation.failure && (
              <p className="mt-2 text-xs text-danger">{result.installation.failure}</p>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

async function catalogRequest<T>(path: string, body?: unknown): Promise<T> {
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
