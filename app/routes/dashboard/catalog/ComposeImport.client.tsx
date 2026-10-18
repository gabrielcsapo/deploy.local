'use client';

import { TextField } from '@/components/ui';
import { useState } from 'react';
import { getAuth } from '../detail/shared.tsx';
import type { ComposeImportUiResult } from './ui-types.ts';

export default function ComposeImportClient() {
  const [source, setSource] = useState('');
  const [applicationName, setApplicationName] = useState('');
  const [result, setResult] = useState<ComposeImportUiResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function inspectCompose() {
    const auth = getAuth();
    if (!auth) {
      setError('Authenticate again to inspect this Compose file.');
      return;
    }
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const response = await fetch('/api/catalog/compose-import', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify({ source, applicationName }),
      });
      const responseText = await response.text();
      let body: ComposeImportUiResult & { error?: string };
      try {
        body = JSON.parse(responseText) as ComposeImportUiResult & { error?: string };
      } catch {
        throw new Error(
          response.status === 404
            ? 'The Catalog handler has not been mounted by this server build.'
            : 'The server returned an unreadable Compose inspection response.',
        );
      }
      if (!response.ok) {
        throw new Error(
          body.error ||
            (response.status === 404
              ? 'The Catalog handler has not been mounted by this server build.'
              : 'Compose inspection failed.'),
        );
      }
      setResult(body);
    } catch (inspectError) {
      setError((inspectError as Error).message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="ds-compose-import space-y-5">
      <header className="page-heading">
        <div>
          <h1 className="page-title">Import Docker Compose</h1>
          <p className="page-description">
            Review your Compose file and convert supported settings to deploy.yaml.
          </p>
        </div>
      </header>

      <section className="card overflow-hidden" aria-labelledby="compose-source-title">
        <header className="border-b border-border px-4 py-4 sm:px-5">
          <h2 id="compose-source-title" className="text-sm font-semibold text-text">
            Compose source
          </h2>
          <p className="mt-1 text-xs text-text-tertiary">
            Avoid literal credentials. They are rejected and should become declared server-side
            configuration.
          </p>
        </header>
        <div className="space-y-4 p-4 sm:p-5">
          <TextField
            className="max-w-md"
            label="Application name"
            value={applicationName}
            onChange={(event) => setApplicationName(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <label className="block">
            <span className="sr-only">Docker Compose YAML</span>
            <textarea
              className="input min-h-96 resize-y whitespace-pre font-mono text-xs leading-5"
              placeholder="Paste your Docker Compose YAML…"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
          </label>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-caption text-text-tertiary">
              Inspection is read-only. No application, volume, network, or catalog record is
              created.
            </p>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => void inspectCompose()}
              disabled={loading || !source.trim() || !applicationName.trim()}
            >
              {loading ? 'Inspecting…' : 'Inspect Compose import'}
            </button>
          </div>
          <div aria-live="polite">
            {error && (
              <p role="alert" className="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger">
                {error}
              </p>
            )}
          </div>
        </div>
      </section>

      {result && <ComposeImportReport result={result} />}
    </div>
  );
}

function ComposeImportReport({ result }: { result: ComposeImportUiResult }) {
  const counts = result.findings.reduce<Record<string, number>>((output, finding) => {
    output[finding.disposition] = (output[finding.disposition] || 0) + 1;
    return output;
  }, {});
  return (
    <section className="card overflow-hidden" aria-labelledby="compose-report-title">
      <header className="border-b border-border px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="compose-report-title" className="text-sm font-semibold text-text">
            Import report
          </h2>
          <span
            className={`badge ${
              result.status === 'ready'
                ? 'badge-success'
                : result.status === 'blocked'
                  ? 'badge-danger'
                  : 'badge-warning'
            }`}
          >
            {result.status}
          </span>
          {Object.entries(counts).map(([name, count]) => (
            <span key={name} className="font-mono text-caption text-text-tertiary">
              {count} {name}
            </span>
          ))}
        </div>
        <p className="mt-2 text-xs text-text-secondary">{result.note}</p>
        {result.spec && (
          <p className="mt-2 font-mono text-caption text-text-tertiary">
            graph: {Object.keys(result.spec.components).length} components ·{' '}
            {Object.keys(result.spec.resources).length} resources ·{' '}
            {Object.keys(result.spec.routes).length} routes
          </p>
        )}
        {result.plan && (
          <div className="mt-3 grid gap-2 text-caption sm:grid-cols-5">
            <Impact label="Capacity">
              {result.plan.impacts.capacity.desiredInstances} instances · peak{' '}
              {result.plan.impacts.capacity.peakInstances}
            </Impact>
            <Impact label="Downtime">{result.plan.impacts.downtime.expectation}</Impact>
            <Impact label="Backup">{result.plan.impacts.backup.disposition}</Impact>
            <Impact label="Data">{result.plan.impacts.data.effect}</Impact>
          </div>
        )}
      </header>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[46rem] text-left text-xs">
          <thead className="bg-bg/50 font-mono text-caption uppercase tracking-wider text-text-tertiary">
            <tr>
              <th className="px-4 py-2 font-medium sm:px-5">Disposition</th>
              <th className="px-4 py-2 font-medium">Compose path</th>
              <th className="px-4 py-2 font-medium">Decision</th>
              <th className="px-4 py-2 font-medium">Security</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {result.findings.map((finding, index) => (
              <tr key={`${finding.path}-${finding.disposition}-${index}`}>
                <td className="px-4 py-3 sm:px-5">
                  <span className={`badge ${findingTone(finding.disposition)}`}>
                    {finding.disposition}
                  </span>
                </td>
                <td className="px-4 py-3 font-mono text-caption text-text-secondary">
                  {finding.path}
                </td>
                <td className="px-4 py-3 text-text-secondary">{finding.summary}</td>
                <td className="px-4 py-3 text-text-tertiary">
                  {finding.securitySensitive ? 'review boundary' : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Impact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <p className="rounded-md border border-border bg-bg/40 px-2.5 py-2 text-text-secondary">
      <span className="block font-mono uppercase tracking-wide text-text-tertiary">{label}</span>
      <span className="mt-0.5 block">{children}</span>
    </p>
  );
}

function findingTone(disposition: ComposeImportUiResult['findings'][number]['disposition']) {
  if (disposition === 'translated') return 'badge-success';
  if (disposition === 'ignored') return 'bg-bg-active text-text-tertiary ring-1 ring-border';
  if (disposition === 'review-required') return 'badge-warning';
  return 'badge-danger';
}
