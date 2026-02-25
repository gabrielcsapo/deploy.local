'use client';

import { useState, useEffect } from 'react';
import { getAuth } from './detail/shared';
import { fetchUser, updatePassword } from '../../actions/user';
import { runVacuum, getMaintenanceStats, getSystemMemoryOverview } from '../../actions/maintenance';

interface UserInfo {
  username: string;
  createdAt: string;
}

interface MaintenanceStats {
  dbSize: number;
  tableCounts: Record<string, number>;
}

interface SystemMemoryOverview {
  system: { totalBytes: number; allocatedBytes: number; availableBytes: number };
  deployments: Array<{ name: string; memoryLimit: string; bytes: number; status: string }>;
}

export default function Component() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  // System memory state
  const [memoryOverview, setMemoryOverview] = useState<SystemMemoryOverview | null>(null);

  // Maintenance state
  const [maintenanceStats, setMaintenanceStats] = useState<MaintenanceStats | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  const [maintenanceError, setMaintenanceError] = useState('');
  const [vacuumRunning, setVacuumRunning] = useState(false);

  useEffect(() => {
    async function load() {
      const auth = getAuth();
      if (!auth) return;
      try {
        const data = await fetchUser(auth.username, auth.token);
        setUser(data as UserInfo);

        // Load maintenance stats + system memory
        const [stats, memory] = await Promise.all([
          getMaintenanceStats(auth.username, auth.token),
          getSystemMemoryOverview(auth.username, auth.token),
        ]);
        setMaintenanceStats(stats as MaintenanceStats);
        setMemoryOverview(memory as SystemMemoryOverview);
      } catch {
        // ignore
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handlePasswordChange(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (!newPassword) {
      setError('New password is required');
      return;
    }

    setSaving(true);
    try {
      const auth = getAuth();
      if (!auth) return;
      await updatePassword(auth.username, auth.token, currentPassword, newPassword);
      setSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function handleVacuum() {
    setMaintenanceMessage('');
    setMaintenanceError('');
    setVacuumRunning(true);

    try {
      const auth = getAuth();
      if (!auth) return;
      const result = await runVacuum(auth.username, auth.token);
      setMaintenanceMessage(result.message);

      // Reload stats after vacuum
      const stats = await getMaintenanceStats(auth.username, auth.token);
      setMaintenanceStats(stats as MaintenanceStats);
    } catch (err) {
      setMaintenanceError((err as Error).message);
    } finally {
      setVacuumRunning(false);
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  }

  if (loading) {
    return <div className="text-sm text-text-tertiary py-12 text-center">Loading...</div>;
  }

  return (
    <div>
      <h1 className="text-lg font-semibold mb-6">Settings</h1>

      {memoryOverview && (
        <div className="card p-6 mb-6">
          <h2 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-4">
            System Memory
          </h2>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">Total System Memory</span>
              <span className="text-sm font-mono">{formatBytes(memoryOverview.system.totalBytes)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">Allocated to Containers</span>
              <span className="text-sm font-mono">{formatBytes(memoryOverview.system.allocatedBytes)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">Available</span>
              <span className="text-sm font-mono font-semibold">{formatBytes(memoryOverview.system.availableBytes)}</span>
            </div>

            <div className="w-full h-3 bg-bg-tertiary rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all ${
                  memoryOverview.system.allocatedBytes / memoryOverview.system.totalBytes > 0.9
                    ? 'bg-red-400'
                    : memoryOverview.system.allocatedBytes / memoryOverview.system.totalBytes > 0.7
                      ? 'bg-yellow-400'
                      : 'bg-accent'
                }`}
                style={{
                  width: `${Math.min(100, (memoryOverview.system.allocatedBytes / memoryOverview.system.totalBytes) * 100)}%`,
                }}
              />
            </div>

            {memoryOverview.deployments.length > 0 && (
              <div className="border-t border-border pt-3">
                <p className="text-xs text-text-tertiary mb-2">Per-Deployment Allocation</p>
                <div className="space-y-1.5">
                  {memoryOverview.deployments.map((d) => (
                    <div key={d.name} className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`w-1.5 h-1.5 rounded-full ${
                          d.status === 'running' ? 'bg-green-400' : 'bg-neutral-500'
                        }`} />
                        <span className="text-xs font-mono">{d.name}</span>
                      </div>
                      <span className="text-xs font-mono text-text-secondary">{d.memoryLimit}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card p-6 mb-6">
        <h2 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-4">
          Account
        </h2>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">Username</span>
            <span className="text-sm font-mono">{user?.username}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">Member since</span>
            <span className="text-sm">
              {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'N/A'}
            </span>
          </div>
        </div>
      </div>

      <div className="card p-6 mb-6">
        <h2 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-4">
          Change Password
        </h2>
        <form onSubmit={handlePasswordChange} className="flex flex-col gap-3 max-w-sm">
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="input"
            required
          />
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="input"
            required
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input"
            required
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          {success && <p className="text-xs text-green-400">{success}</p>}
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Change Password'}
          </button>
        </form>
      </div>

      <div className="card p-6">
        <h2 className="text-xs font-semibold text-text-tertiary uppercase tracking-wider mb-4">
          Database Maintenance
        </h2>

        {maintenanceStats && (
          <div className="mb-6 space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-secondary">Database Size</span>
              <span className="text-sm font-mono">{formatBytes(maintenanceStats.dbSize)}</span>
            </div>

            <div className="border-t border-border pt-3">
              <p className="text-xs text-text-tertiary mb-2">Table Row Counts</p>
              <div className="grid grid-cols-2 gap-2">
                {Object.entries(maintenanceStats.tableCounts).map(([table, count]) => (
                  <div key={table} className="flex items-center justify-between">
                    <span className="text-xs text-text-secondary font-mono">{table}</span>
                    <span className="text-xs font-mono">{count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <div className="space-y-4 max-w-sm">
          <div>
            <button
              onClick={handleVacuum}
              disabled={vacuumRunning}
              className="btn btn-primary w-full"
            >
              {vacuumRunning ? 'Running VACUUM...' : 'Run Database VACUUM'}
            </button>
            <p className="text-xs text-text-tertiary mt-1">
              Reclaims disk space from deleted records by rebuilding the database file.
            </p>
          </div>

          {maintenanceMessage && <p className="text-xs text-green-400">{maintenanceMessage}</p>}
          {maintenanceError && <p className="text-xs text-danger">{maintenanceError}</p>}

          <div className="border-t border-border pt-4">
            <p className="text-xs text-text-tertiary">
              <strong>Automated Maintenance:</strong> VACUUM runs every 6 hours automatically to
              keep the database optimized. All data is preserved indefinitely - you can delete old
              data manually if needed.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
