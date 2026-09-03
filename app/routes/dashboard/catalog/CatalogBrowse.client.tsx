'use client';

import { Link } from 'react-flight-router/client';
import { useMemo, useState } from 'react';
import CatalogInstallationsClient from './CatalogInstallations.client.tsx';
import type { CatalogUiRelease } from './ui-types.ts';

export default function CatalogBrowseClient({ releases }: { releases: CatalogUiRelease[] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const categories = useMemo(
    () => [...new Set(releases.flatMap((release) => release.categories))].sort(),
    [releases],
  );
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return releases.filter((release) => {
      const matchesCategory = category === 'all' || release.categories.includes(category);
      const matchesQuery =
        !needle ||
        [release.name, release.id, release.summary, ...release.categories]
          .join(' ')
          .toLowerCase()
          .includes(needle);
      return matchesCategory && matchesQuery;
    });
  }, [category, query, releases]);

  return (
    <div className="space-y-6">
      <header className="page-heading">
        <div className="max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow">Application catalog</p>
            <span className="badge badge-success">{releases.length} verified releases</span>
          </div>
          <h1 className="page-title mt-3">Supported applications</h1>
          <p className="page-description">
            Choose a verified application, validate it against a real deployment target, and install
            the approved graph.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-[7px] border border-border bg-bg-surface px-3 py-2 font-mono text-[10px] uppercase tracking-[0.05em] text-text-tertiary">
            {releases.length} signed contracts
          </span>
          <Link to="/dashboard/catalog/import" className="btn btn-primary btn-sm">
            Import Docker Compose
          </Link>
        </div>
      </header>

      <CatalogInstallationsClient />

      <section aria-labelledby="catalog-releases-title">
        <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div>
            <h2 id="catalog-releases-title" className="text-base font-semibold text-text">
              Blueprint releases
            </h2>
            <p className="mt-1 text-xs text-text-tertiary">
              Support, target, offline, suitcase, and data promises stay separate.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label>
              <span className="sr-only">Search catalog releases</span>
              <input
                className="input input-sm w-full font-mono sm:w-56"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="search blueprints…"
              />
            </label>
            <label>
              <span className="sr-only">Filter catalog category</span>
              <select
                className="input input-sm"
                value={category}
                onChange={(event) => setCategory(event.target.value)}
              >
                <option value="all">All categories</option>
                {categories.map((item) => (
                  <option key={item} value={item}>
                    {item}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        {visible.length === 0 ? (
          <div className="card p-8 text-center">
            <p className="text-sm text-text-secondary">No blueprint matches this review filter.</p>
            <button
              type="button"
              className="mt-3 text-xs text-accent hover:text-accent-hover"
              onClick={() => {
                setQuery('');
                setCategory('all');
              }}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-3">
            {visible.map((release) => (
              <CatalogReleaseCard key={`${release.id}@${release.release}`} release={release} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function CatalogReleaseCard({ release }: { release: CatalogUiRelease }) {
  const blocked = release.stage === 'blocked' || !release.preflight.ready;
  return (
    <article className="card topology-seam group flex min-h-72 flex-col overflow-hidden pl-px transition-colors hover:border-border-hover">
      <div className="flex-1 p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={`badge ${blocked ? 'badge-danger' : 'badge-success'}`}>
            {blocked ? 'Blocked on reference target' : 'Ready for target check'}
          </span>
          <span className="font-mono text-[10px] text-text-tertiary">v{release.release}</span>
        </div>
        <h3 className="mt-4 text-base font-semibold tracking-tight text-text">{release.name}</h3>
        <p className="mt-2 text-xs leading-relaxed text-text-secondary">{release.summary}</p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {release.categories.map((item) => (
            <span
              key={item}
              className="rounded-md border border-border bg-bg/40 px-2 py-1 font-mono text-[10px] text-text-tertiary"
            >
              {item}
            </span>
          ))}
        </div>
        <dl className="mt-5 grid grid-cols-3 gap-2 border-t border-border/80 pt-4 text-center">
          <Metric label="components" value={Object.keys(release.graph.components).length} />
          <Metric label="resources" value={Object.keys(release.graph.resources).length} />
          <Metric label="grants" value={release.security.length} />
        </dl>
      </div>
      <div className="border-t border-border bg-bg/30 px-4 py-3 sm:px-5">
        <div className="mb-3 flex items-center gap-2 font-mono text-[10px] text-text-tertiary">
          <span className="size-1.5 shrink-0 rounded-full bg-success" aria-hidden="true" />
          <span className="truncate" title={release.contentDigest}>
            signed · {release.contentDigest.slice(0, 22)}…
          </span>
        </div>
        <Link
          to={`/dashboard/catalog/${encodeURIComponent(release.id)}/${encodeURIComponent(release.release)}`}
          className="btn btn-sm w-full text-xs"
        >
          Configure installation
        </Link>
      </div>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <dt className="text-[9px] font-mono uppercase tracking-wider text-text-tertiary">{label}</dt>
      <dd className="mt-1 text-sm font-semibold tabular-nums text-text">{value}</dd>
    </div>
  );
}
