'use client';
import { Select, SearchField } from '@/components/ui';

import { Link } from 'react-flight-router/client';
import { useMemo, useState } from 'react';
import CatalogInstallationsClient from './CatalogInstallations.client.tsx';
import type { CatalogUiRelease } from './ui-types.ts';
import { WorkspaceIcon } from '../workspace-icon';

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
    <div className="ds-catalog">
      <CatalogInstallationsClient />
      <div className="ds-pane-toolbar ds-catalog-toolbar">
        <SearchField
          label="Search catalog releases"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <label>
          <span className="sr-only">Filter catalog category</span>
          <Select
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
          </Select>
        </label>
      </div>
      {visible.length === 0 ? (
        <div className="ds-feedback" role="status">
          <span>No applications match your filters.</span>
          <button
            className="btn btn-sm"
            onClick={() => {
              setQuery('');
              setCategory('all');
            }}
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="ds-catalog-list">
          {visible.map((release) => (
            <CatalogReleaseCard key={`${release.id}@${release.release}`} release={release} />
          ))}
        </div>
      )}
    </div>
  );
}

function CatalogReleaseCard({ release }: { release: CatalogUiRelease }) {
  const blocked = release.stage === 'blocked';
  return (
    <Link
      className="ds-catalog-row"
      to={`/dashboard/catalog/${encodeURIComponent(release.id)}`}
      aria-label={release.name}
      aria-describedby={`catalog-${release.id}-summary`}
    >
      <AppIcon release={release} />
      <div className="ds-catalog-description">
        <h2>{release.name}</h2>
        <p id={`catalog-${release.id}-summary`}>{release.summary}</p>
        <small>{release.categories.join(', ')}</small>
      </div>
      <div className="ds-catalog-actions">
        {blocked && <span className="text-danger">Unavailable</span>}
        <WorkspaceIcon name="chevron" />
      </div>
    </Link>
  );
}

function AppIcon({ release }: { release: CatalogUiRelease }) {
  return (
    <div className="flex size-12 shrink-0 items-center justify-center rounded-xl border border-border bg-white p-2.5 shadow-sm">
      <img src={release.iconUrl} alt="" className="size-full object-contain" loading="lazy" />
    </div>
  );
}
