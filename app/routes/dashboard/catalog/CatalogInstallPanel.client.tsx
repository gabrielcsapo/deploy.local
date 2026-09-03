'use client';

import { useEffect, useState } from 'react';
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
  const [targetSiteId, setTargetSiteId] = useState('');
  const [applicationName, setApplicationName] = useState(release.graph.metadata.name || release.id);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [preflight, setPreflight] = useState<CatalogPreflightResult | null>(null);
  const [result, setResult] = useState<InstallResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const body = await catalogRequest<{ targets: CatalogTargetProfile[] }>(
          '/api/catalog/targets',
        );
        setTargets(body.targets);
        setTargetSiteId(
          body.targets.find((target) => target.siteId === 'coordinator')?.siteId ||
            body.targets[0]?.siteId ||
            '',
        );
      } catch (loadError) {
        setError((loadError as Error).message);
      }
    })();
  }, []);

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
        <p className="eyebrow">Target admission</p>
        <h2 id="catalog-install-title" className="mt-1 text-sm font-semibold text-text">
          Preflight the actual site, then install
        </h2>
        <p className="mt-1 text-xs text-text-tertiary">
          Capacity and grants are derived from coordinator or authenticated node facts. Secrets stay
          server-side.
        </p>
      </header>
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 md:grid-cols-2">
          <label>
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">
              Application name
            </span>
            <input
              className="input input-sm"
              value={applicationName}
              onChange={(event) => {
                setApplicationName(event.target.value);
                setPreflight(null);
              }}
            />
          </label>
          <label>
            <span className="mb-1.5 block text-xs font-medium text-text-secondary">
              Deployment target
            </span>
            <select
              className="input input-sm"
              value={targetSiteId}
              onChange={(event) => {
                setTargetSiteId(event.target.value);
                setPreflight(null);
              }}
            >
              {targets.map((target) => (
                <option key={target.siteId} value={target.siteId}>
                  {target.siteKind === 'coordinator'
                    ? 'Home'
                    : target.siteKind === 'suitcase'
                      ? 'Suitcase'
                      : 'Node'}{' '}
                  · {target.siteId} · {target.operatingSystem}/{target.architecture} ·{' '}
                  {Math.round(target.memoryMiB / 1024)} GiB
                </option>
              ))}
            </select>
          </label>
        </div>
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
                  <span className="mt-1 block text-[10px] text-text-tertiary">{question.help}</span>
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
            {busy ? 'Checking…' : 'Run preflight'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy || !preflight?.ready}
            onClick={() => void submit('install')}
          >
            Install approved plan
          </button>
        </div>
        {preflight && (
          <div
            className={`rounded-lg border px-3 py-3 ${preflight.ready ? 'border-success/30 bg-success/5' : 'border-danger/30 bg-danger/5'}`}
          >
            <p className="text-xs font-medium text-text">
              {preflight.ready ? 'Ready to install' : 'Preflight blocked'}
            </p>
            <ul className="mt-2 space-y-1 text-[11px] text-text-secondary">
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
              <span className="font-mono text-[10px] text-text-tertiary">
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
