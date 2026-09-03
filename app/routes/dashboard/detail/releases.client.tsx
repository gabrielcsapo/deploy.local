'use client';

import { useCallback, useEffect, useState } from 'react';
import type { ApplicationChangePlan } from '../../../../server/application-plan.ts';
import { ErrorBanner } from '../../../components/LoadingState';
import { useToast } from '../../../components/Toaster';
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

interface ReleaseCandidate {
  id: string;
  app_id: string;
  origin_site_id: string;
  base_generation: number;
  architecture: string | null;
  state: string;
  created_at: string;
  plan: ApplicationChangePlan | null;
}

export default function ReleasesClient() {
  const { deployment } = useDetailContext();
  const { toast } = useToast();
  const [spec, setSpec] = useState<SpecState | null>(null);
  const [candidates, setCandidates] = useState<ReleaseCandidate[]>([]);
  const [error, setError] = useState('');
  const [acting, setActing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    const headers = {
      'x-deploy-username': auth.username,
      'x-deploy-token': auth.token,
    };
    try {
      const [specResponse, fleetResponse] = await Promise.all([
        fetch(`/api/deployments/${encodeURIComponent(deployment.name)}/application-spec`, {
          headers,
        }),
        fetch('/api/fleet/topology', { headers }),
      ]);
      const specBody = await specResponse.json();
      if (!specResponse.ok) throw new Error(specBody.error || 'Unable to load release revisions');
      setSpec(specBody as SpecState);
      if (fleetResponse.ok) {
        const fleetBody = await fleetResponse.json();
        setCandidates(
          ((fleetBody.releaseCandidates ?? []) as ReleaseCandidate[]).filter(
            (candidate) => candidate.app_id === deployment.appId,
          ),
        );
      }
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [deployment.appId, deployment.name]);

  useEffect(() => {
    void load();
  }, [load]);

  async function candidateAction(candidate: ReleaseCandidate, action: 'promote' | 'discard') {
    const auth = getAuth();
    if (!auth) return;
    setActing(candidate.id);
    setError('');
    try {
      const confirmDestructive =
        action === 'promote' && candidate.plan?.destructive === true
          ? window.confirm(
              'This offline candidate has destructive data effects. Promote only after verifying the required backup and reviewing every removed stable resource key.',
            )
          : false;
      if (action === 'promote' && candidate.plan?.destructive && !confirmDestructive) return;
      const response = await fetch(
        `/api/fleet/release-candidates/${encodeURIComponent(candidate.id)}/${action}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({ confirmDestructive }),
        },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Unable to ${action} release candidate`);
      toast(`candidate-${candidate.id}`, {
        type: 'success',
        title: action === 'promote' ? 'Release candidate promoted' : 'Release candidate discarded',
        description:
          action === 'promote'
            ? 'Home accepted the suitcase build as the next authoritative generation.'
            : 'The candidate will no longer appear as a pending release decision.',
      });
      await load();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : String(actionError));
    } finally {
      setActing(null);
    }
  }

  const aligned = Boolean(spec?.activeDigest && spec.activeDigest === spec.desiredDigest);
  return (
    <div className="space-y-4">
      <header>
        <p className="eyebrow">Releases</p>
        <h2 className="mt-1 text-lg font-semibold">One history, builds from any site</h2>
        <p className="mt-1 max-w-3xl text-sm text-text-secondary">
          Desired and active revisions stay immutable. A suitcase build returns as a candidate until
          Home promotes it.
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
              Repository, UI, legacy, and suitcase origins converge on the same application
              identity.
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

      {candidates.length > 0 && (
        <section className="card overflow-hidden" aria-labelledby="candidate-title">
          <div className="border-b border-border px-4 py-4 sm:px-5">
            <h3 id="candidate-title" className="text-sm font-semibold">
              Suitcase release candidates
            </h3>
            <p className="mt-1 text-xs text-text-tertiary">
              Promotion is explicit so an offline site cannot silently replace Home’s release.
            </p>
          </div>
          <ul className="divide-y divide-border/80">
            {candidates.map((candidate) => (
              <li
                key={candidate.id}
                className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5"
              >
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs font-semibold">{candidate.origin_site_id}</code>
                    <span className="badge badge-warning">
                      {candidate.state.replaceAll('-', ' ')}
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[10px] text-text-tertiary">
                    base generation {candidate.base_generation} ·{' '}
                    {candidate.architecture ?? 'architecture unknown'}
                  </p>
                  {candidate.plan && (
                    <p className="mt-2 text-[11px] text-text-secondary">
                      {candidate.plan.impacts.capacity.currentInstances} →{' '}
                      {candidate.plan.impacts.capacity.desiredInstances} instances · downtime{' '}
                      {candidate.plan.impacts.downtime.expectation} · backup{' '}
                      {candidate.plan.impacts.backup.disposition} · data{' '}
                      {candidate.plan.impacts.data.effect} · suitcase{' '}
                      {candidate.plan.impacts.suitcase.disposition}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="btn btn-sm text-xs"
                    disabled={acting === candidate.id}
                    onClick={() => void candidateAction(candidate, 'discard')}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm text-xs"
                    disabled={acting === candidate.id || candidate.state !== 'ready-to-promote'}
                    onClick={() => void candidateAction(candidate, 'promote')}
                  >
                    {acting === candidate.id ? 'Working…' : 'Promote'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

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
