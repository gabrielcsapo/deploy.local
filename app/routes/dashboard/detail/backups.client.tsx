'use client';

import { useState, useEffect, useCallback } from 'react';
import { useDetailContext } from './shared';
import {
  fetchBackups as serverFetchBackups,
  createBackup as serverCreateBackup,
  restoreBackup as serverRestoreBackup,
  deleteBackup as serverDeleteBackup,
  updateDeploymentSettings as serverUpdateSettings,
} from '../../../actions/deployments';
import { getAuth } from './shared';
import { formatBytes } from '../../../utils';
import { Toggle } from '../../../components/Toggle';
import { LoadingState, ErrorBanner } from '../../../components/LoadingState';
import { ConfirmDialog } from '../../../components/ConfirmDialog';

interface Backup {
  id: number;
  filename: string;
  label: string | null;
  sizeBytes: number;
  createdBy: string;
  createdAt: string;
}

export default function Component() {
  const { deployment, fetchDeployment } = useDetailContext();
  const name = deployment.name;

  const [backups, setBackups] = useState<Backup[]>([]);
  const [volumeSize, setVolumeSize] = useState(0);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    confirmLabel: string;
    danger: boolean;
    onConfirm: () => void;
  } | null>(null);

  const loadBackups = useCallback(async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      const data = await serverFetchBackups(auth.username, auth.token, name);
      setBackups(data.backups as Backup[]);
      setVolumeSize(data.volumeSize);
      setError('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    loadBackups();
  }, [loadBackups]);

  const handleCreate = async () => {
    if (creating) return;
    setCreating(true);
    setError('');

    try {
      const auth = getAuth();
      if (!auth) return;
      await serverCreateBackup(auth.username, auth.token, name, label || undefined);
      setLabel('');
      await loadBackups();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const handleRestore = (filename: string) => {
    setConfirmState({
      title: 'Restore Backup',
      message: `Restore backup "${filename}"? This will replace current data and restart the container.`,
      confirmLabel: 'Restore',
      danger: false,
      onConfirm: async () => {
        setConfirmState(null);
        setRestoring(filename);
        setError('');
        setSuccessMessage('');

        try {
          const auth = getAuth();
          if (!auth) return;
          await serverRestoreBackup(auth.username, auth.token, name, filename);
          await fetchDeployment();
          setSuccessMessage('Backup restored successfully!');
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setRestoring(null);
        }
      },
    });
  };

  const handleDelete = (filename: string) => {
    setConfirmState({
      title: 'Delete Backup',
      message: `Delete backup "${filename}"? This action cannot be undone.`,
      confirmLabel: 'Delete',
      danger: true,
      onConfirm: async () => {
        setConfirmState(null);
        setDeleting(filename);
        setError('');
        setSuccessMessage('');

        try {
          const auth = getAuth();
          if (!auth) return;
          await serverDeleteBackup(auth.username, auth.token, name, filename);
          await loadBackups();
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setDeleting(null);
        }
      },
    });
  };

  const handleToggleAutoBackup = async () => {
    try {
      const auth = getAuth();
      if (!auth) return;
      await serverUpdateSettings(auth.username, auth.token, name, {
        autoBackup: !deployment.autoBackup,
      });
      await fetchDeployment();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) {
    return <LoadingState />;
  }

  return (
    <div className="space-y-6">
      {/* Volume Info */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs text-text-tertiary mb-1">Volume Size</p>
            <p className="text-lg font-semibold font-mono">{formatBytes(volumeSize)}</p>
            <p className="text-xs text-text-secondary mt-0.5">
              Mounted at /app/data and /app/uploads
            </p>
          </div>
          <div className="text-right">
            <p className="text-xs text-text-tertiary mb-1">Backups</p>
            <p className="text-lg font-semibold">{backups.length}</p>
          </div>
        </div>
      </div>

      {/* Auto-Backup Setting */}
      <div className="card p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-semibold mb-1">Auto-Backup Before Deploy</p>
            <p className="text-xs text-text-secondary">
              Automatically create a backup before each deployment
            </p>
          </div>
          <Toggle
            enabled={!!deployment.autoBackup}
            onChange={handleToggleAutoBackup}
            label="Auto-Backup"
          />
        </div>
      </div>

      {/* Large Volume Warning */}
      {volumeSize > 10 * 1024 * 1024 * 1024 && (
        <div className="card p-4 bg-warning/10 border border-warning/20">
          <p className="text-sm text-warning font-medium mb-1">⚠️ Large Volume Detected</p>
          <p className="text-xs text-text-secondary">
            Your volume is {formatBytes(volumeSize)}. Large volumes may take several minutes to
            backup and restore. Backups are created asynchronously without blocking your server.
          </p>
        </div>
      )}

      {/* Create Backup */}
      <div className="card p-4">
        <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-3">
          Create Backup
        </h3>
        <div className="flex gap-2">
          <input
            type="text"
            placeholder="Optional label (e.g., before-migration)"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="input flex-1"
            disabled={creating}
          />
          <button onClick={handleCreate} disabled={creating} className="btn btn-primary">
            {creating ? 'Creating...' : 'Create Backup'}
          </button>
        </div>
        <p className="text-xs text-text-secondary mt-2">
          Creates a gzip-compressed archive of your volume data (non-blocking)
        </p>
      </div>

      {/* Success Banner */}
      {successMessage && (
        <div className="rounded-lg border border-success/30 bg-success/10 px-4 py-3 text-sm text-success flex items-center justify-between">
          {successMessage}
          <button
            onClick={() => setSuccessMessage('')}
            className="text-success/70 hover:text-success ml-2"
          >
            &times;
          </button>
        </div>
      )}

      {/* Error Display */}
      {error && <ErrorBanner message={error} />}

      {/* Backups List */}
      <div className="card overflow-hidden">
        <div className="px-4 py-3 border-b border-border">
          <h3 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider">
            Backup History
          </h3>
        </div>
        {backups.length === 0 ? (
          <div className="p-6 text-center text-sm text-text-secondary">
            No backups yet. Create your first backup above.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {backups.map((backup) => (
              <div key={backup.id} className="px-4 py-3 flex items-center gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium font-mono truncate">{backup.filename}</p>
                  <p className="text-xs text-text-secondary">
                    {backup.label && <span className="mr-2">📝 {backup.label}</span>}
                    {formatBytes(backup.sizeBytes)} · by {backup.createdBy}
                  </p>
                </div>
                <time className="text-xs text-text-tertiary shrink-0">
                  {new Date(backup.createdAt).toLocaleString()}
                </time>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => handleRestore(backup.filename)}
                    disabled={restoring === backup.filename}
                    className="btn btn-sm btn-secondary"
                  >
                    {restoring === backup.filename ? 'Restoring...' : 'Restore'}
                  </button>
                  <button
                    onClick={() => handleDelete(backup.filename)}
                    disabled={deleting === backup.filename}
                    className="btn btn-sm btn-danger"
                  >
                    {deleting === backup.filename ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmState !== null}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        confirmLabel={confirmState?.confirmLabel}
        danger={confirmState?.danger}
        onConfirm={() => confirmState?.onConfirm()}
        onCancel={() => setConfirmState(null)}
      />
    </div>
  );
}
