'use client';

import { useState, useMemo } from 'react';
import { Link } from 'react-flight-router/client';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { AppTable } from '../../components/dashboard/AppTable';
import { EmptyState } from '../../components/dashboard/EmptyState';
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
        <ApplicationsHeading count={0} total={0} />
        <LoadingState />
      </div>
    );
  }

  return (
    <div>
      <div className="page-heading">
        <div>
          <h1 className="page-title">Applications</h1>
          <p className="page-description !mt-1">
            {filtered.length} of {deployments.length}{' '}
            {deployments.length === 1 ? 'deployment' : 'deployments'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {deployments.length > 0 && (
            <input
              type="text"
              placeholder="Filter applications…"
              data-appearance="plain"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input input-sm w-56"
              aria-label="Filter apps"
            />
          )}
          <Link to="/dashboard/catalog" className="btn btn-primary btn-sm">
            Add application
          </Link>
        </div>
      </div>

      {error && <ErrorBanner message={error} />}

      {deployments.length === 0 ? (
        <EmptyState
          title="No applications yet"
          description="Add an application from the catalog or deploy a project from the CLI."
        />
      ) : filtered.length === 0 ? (
        <div className="ds-feedback">
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

function ApplicationsHeading({ count, total }: { count: number; total: number }) {
  return (
    <header className="page-heading">
      <div>
        <h1 className="page-title">Applications</h1>
        <p className="page-description !mt-1">
          {count} of {total} deployments
        </p>
      </div>
    </header>
  );
}
