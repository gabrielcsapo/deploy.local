'use client';

import { useState, useMemo } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { AppTable } from '../../components/dashboard/AppTable';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import { useToast } from '../../components/Toaster';
import { restartDeployment as serverRestart } from '../../actions/deployments';
import { getAuth } from './detail/shared';
import { useDashboardData } from './data.client';

/**
 * Apps — the dense, sortable, filterable list. Lives at /dashboard/apps so
 * the Overview can stay focused on fleet-wide signals instead of a long
 * scrolling table.
 */
export default function AppsClient() {
  const { deployments, cards, loading, error, handleDelete } = useDashboardData();
  const { toast } = useToast();
  const [search, setSearch] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [bulkDeleteTargets, setBulkDeleteTargets] = useState<string[] | null>(null);

  async function handleBulkRestart(names: string[]) {
    const auth = getAuth();
    if (!auth) return;
    const toastId = `bulk-restart-${Date.now()}`;
    toast(toastId, {
      type: 'loading',
      title: `Restarting ${names.length} ${names.length === 1 ? 'app' : 'apps'}…`,
    });
    const results = await Promise.allSettled(
      names.map((n) => serverRestart(auth.username, auth.token, n)),
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed === 0) {
      toast(toastId, {
        type: 'success',
        title: `Restarted ${names.length} ${names.length === 1 ? 'app' : 'apps'}`,
      });
    } else {
      toast(toastId, {
        type: 'error',
        title: `Restarted ${names.length - failed}, failed ${failed}`,
        description: 'See per-app activity for details.',
      });
    }
  }

  async function handleBulkDelete(names: string[]) {
    // Run deletes in series so each one fires its WS event and the data
    // shell can keep its deployments list in sync without races.
    for (const n of names) {
      await handleDelete(n);
    }
    toast(`bulk-delete-${Date.now()}`, {
      type: 'success',
      title: `Deleted ${names.length} ${names.length === 1 ? 'app' : 'apps'}`,
    });
  }

  const filtered = useMemo(() => {
    if (!search) return cards;
    const q = search.toLowerCase();
    return cards.filter((c) => c.name.toLowerCase().includes(q));
  }, [cards, search]);

  if (loading && deployments.length === 0) {
    return (
      <div>
        <div className="flex items-center justify-between mb-4">
          <h1 className="prompt-h1">Apps</h1>
        </div>
        <LoadingState />
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div>
          <h1 className="prompt-h1">Apps</h1>
          <p className="text-xs text-text-tertiary mt-0.5 tabular-nums">
            {filtered.length} of {deployments.length}{' '}
            {deployments.length === 1 ? 'deployment' : 'deployments'}
          </p>
        </div>
        {deployments.length > 0 && (
          <input
            type="text"
            placeholder="filter…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="input input-sm w-56 font-mono"
            aria-label="Filter apps"
          />
        )}
      </div>

      {error && <ErrorBanner message={error} />}

      {deployments.length === 0 ? (
        <div className="card flex flex-col items-center text-center py-16 px-6">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl border border-white/[0.06] bg-bg/60 text-accent mb-4">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              className="size-5"
            >
              <path d="M4 7v10l8 4 8-4V7l-8-4-8 4z" />
              <path d="M4 7l8 4 8-4" />
              <path d="M12 11v10" />
            </svg>
          </div>
          <h2 className="text-base font-semibold tracking-tight mb-1.5">No apps yet</h2>
          <p className="text-sm text-text-secondary max-w-[44ch] leading-relaxed mb-5">
            Run{' '}
            <code className="font-mono text-text bg-bg-hover px-1.5 py-0.5 rounded">deploy</code>{' '}
            from any project directory and it will appear here within seconds.
          </p>
          <a href="/docs/cli" className="btn btn-sm">
            Read the CLI docs
          </a>
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-8 text-center text-sm text-text-tertiary">
          No deployments match &ldquo;{search}&rdquo;.{' '}
          <button
            type="button"
            onClick={() => setSearch('')}
            className="text-accent hover:text-accent-hover transition-colors"
          >
            Clear filter
          </button>
        </div>
      ) : (
        <AppTable
          cards={filtered}
          onDelete={(name) => setDeleteTarget(name)}
          onBulkRestart={handleBulkRestart}
          onBulkDelete={(names) => setBulkDeleteTargets(names)}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete Deployment"
        message={`Delete ${deleteTarget}? This stops the container and removes its database row. Persisted volumes remain on disk.`}
        confirmLabel="Delete"
        danger
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget);
          setDeleteTarget(null);
        }}
        onCancel={() => setDeleteTarget(null)}
      />

      <ConfirmDialog
        open={bulkDeleteTargets !== null}
        title={`Delete ${bulkDeleteTargets?.length ?? 0} ${bulkDeleteTargets?.length === 1 ? 'deployment' : 'deployments'}?`}
        message={`This will stop and remove: ${bulkDeleteTargets?.join(', ') ?? ''}. Persisted volumes remain on disk.`}
        confirmLabel="Delete all"
        danger
        requireTypedConfirmation="delete"
        onConfirm={() => {
          if (bulkDeleteTargets) handleBulkDelete(bulkDeleteTargets);
          setBulkDeleteTargets(null);
        }}
        onCancel={() => setBulkDeleteTargets(null)}
      />
    </div>
  );
}
