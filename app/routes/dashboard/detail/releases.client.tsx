'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../../../components/LoadingState';
import { BuildIcon } from '../../../components/dashboard/icons';
import BuildClient from './build.client';
import { getAuth, useDetailContext } from './shared';

interface Revision {
  digest: string;
  parentDigest: string | null;
  source: string;
  manifestFormat: string;
  createdBy: string | null;
  createdAt: string;
  active: boolean;
}

interface SpecState {
  desiredDigest: string | null;
  activeDigest: string | null;
  revisions: Revision[];
}

export default function ReleasesClient() {
  const { deployment } = useDetailContext();
  const [spec, setSpec] = useState<SpecState | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    const headers = {
      'x-deploy-username': auth.username,
      'x-deploy-token': auth.token,
    };
    try {
      const specResponse = await fetch(
        `/api/deployments/${encodeURIComponent(deployment.name)}/application-spec`,
        { headers },
      );
      const specBody = await specResponse.json();
      if (!specResponse.ok) throw new Error(specBody.error || 'Unable to load release revisions');
      setSpec(specBody as SpecState);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [deployment.name]);

  useEffect(() => {
    void load();
  }, [load]);

  const aligned = Boolean(spec?.activeDigest && spec.activeDigest === spec.desiredDigest);
  return (
    <div className="space-y-4">
      <header>
        <p className="eyebrow">Releases</p>
        <h2 className="mt-1 text-lg font-semibold">Release history</h2>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">
          Track the desired revision, active release, and build results for this application.
        </p>
      </header>

      {error && <ErrorBanner message={error} />}

      <section className="card overflow-hidden" aria-labelledby="release-lineage-title">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
          <div>
            <div className="flex items-center gap-2">
              <BuildIcon className="size-4 text-accent" />
              <h3 id="release-lineage-title" className="text-sm font-semibold">
                Revision lineage
              </h3>
            </div>
            <p className="mt-1 text-xs text-text-tertiary">
              Repository and dashboard changes share the same revision history.
            </p>
          </div>
          <span className={`badge ${aligned ? 'badge-success' : 'badge-warning'}`}>
            {aligned ? 'active matches desired' : 'activation pending'}
          </span>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-2">
          <DigestCard label="Desired" digest={spec?.desiredDigest ?? null} />
          <DigestCard label="Active" digest={spec?.activeDigest ?? null} />
        </div>
        {spec?.revisions.length ? (
          <div className="overflow-x-auto border-t border-border">
            <table className="w-full min-w-[720px] text-left text-xs">
              <thead className="border-b border-border bg-bg-surface/60 text-[10px] uppercase tracking-wider text-text-tertiary">
                <tr>
                  <th className="px-4 py-2.5 font-medium">Revision</th>
                  <th className="px-4 py-2.5 font-medium">Origin</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium">State</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {spec.revisions.map((revision) => (
                  <tr key={revision.digest}>
                    <td className="max-w-md break-all px-4 py-3 font-mono text-[10px] text-text-secondary">
                      {revision.digest}
                    </td>
                    <td className="px-4 py-3">
                      {revision.source} · {revision.manifestFormat}
                    </td>
                    <td className="px-4 py-3 text-text-tertiary">
                      {new Date(revision.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3">
                      {revision.active ? (
                        <span className="badge badge-success">active</span>
                      ) : revision.digest === spec.desiredDigest ? (
                        <span className="badge badge-accent">desired</span>
                      ) : (
                        <span className="text-text-tertiary">superseded</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 py-6 text-xs text-text-tertiary">
            No immutable release revisions have been recorded.
          </p>
        )}
      </section>

      <section aria-labelledby="build-records-title">
        <div className="mb-3">
          <h3 id="build-records-title" className="text-sm font-semibold">
            Build records
          </h3>
          <p className="mt-1 text-xs text-text-tertiary">
            Compiler output and runtime logs remain attached to each deploy attempt.
          </p>
        </div>
        <BuildClient />
      </section>
    </div>
  );
}

function DigestCard({ label, digest }: { label: string; digest: string | null }) {
  return (
    <div className="bg-bg px-4 py-4 sm:px-5">
      <p className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">{label}</p>
      <code className="mt-2 block break-all text-[11px] text-text-secondary">
        {digest ?? 'Not available'}
      </code>
    </div>
  );
}
