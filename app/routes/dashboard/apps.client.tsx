'use client';

import { useState, useMemo } from 'react';
import { Link } from 'react-flight-router/client';
import { ListPageHeader, TextField } from '../../components/ui';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ApplicationList } from './application-list.client';
import { EmptyState } from '../../components/dashboard/EmptyState';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import { useToast } from '../../components/Toaster';
import { restartDeployment as serverRestart } from '../../actions/deployments';
import { getAuth } from './detail/shared';
import { useDashboardData } from './data.client';

/**
 * Applications — a quiet, filterable resource list. Lives at /dashboard/apps so
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

  return (
    <div>
      <ListPageHeader>
        <Link to="/dashboard/catalog" className="ui-button ui-button-primary">
          Add application
        </Link>
        <TextField
          label="Filter applications"
          appearance="plain"
          type="search"
          placeholder="Filter applications…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </ListPageHeader>

      {error && <ErrorBanner message={error} />}

      {loading && deployments.length === 0 ? (
        <LoadingState />
      ) : deployments.length === 0 ? (
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
        <ApplicationList
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
