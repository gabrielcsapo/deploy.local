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
          <h1 className="page-title">Application catalog</h1>
          <p className="page-description">Choose an application to run on your computers.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
              Application templates
            </h2>
            <p className="mt-1 text-xs text-text-tertiary">
              Review requirements and choose where to install.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label>
              <span className="sr-only">Search catalog releases</span>
              <input
                className="input input-sm w-full sm:w-56"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search applications…"
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
            <p className="text-sm text-text-secondary">No applications match your filters.</p>
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
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
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
    <article className="card group flex flex-col overflow-hidden transition-colors hover:border-border-hover">
      <div className="flex-1 p-4 sm:p-5">
        <div className="flex items-center gap-3">
          <AppIcon release={release} />
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold tracking-tight text-text">
              {release.name}
            </h3>
            <a
              href={release.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 inline-flex items-center gap-1 text-xs text-text-tertiary transition-colors hover:text-text"
            >
              Open source on GitHub
              <ExternalLinkGlyph />
            </a>
          </div>
        </div>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">{release.summary}</p>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {release.categories.map((item) => (
            <span
              key={item}
              className="rounded-md border border-border bg-bg/40 px-2 py-1 text-xs text-text-tertiary"
            >
              {item}
            </span>
          ))}
        </div>
      </div>
      <div className="border-t border-border bg-bg/30 px-4 py-3 sm:px-5">
        {blocked && <p className="mb-3 text-xs text-danger">Currently unavailable</p>}
        <Link
          to={`/dashboard/catalog/${encodeURIComponent(release.id)}`}
          className="btn btn-sm w-full text-xs"
        >
          View template
        </Link>
      </div>
    </article>
  );
}

function AppIcon({ release }: { release: CatalogUiRelease }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-white p-2.5 shadow-sm">
      <img src={release.iconUrl} alt="" className="size-full object-contain" loading="lazy" />
    </div>
  );
}

function ExternalLinkGlyph() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-3">
      <path
        d="M6 3.5H3.5v9h9V10M9 3.5h3.5V7M12.25 3.75 7 9"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
