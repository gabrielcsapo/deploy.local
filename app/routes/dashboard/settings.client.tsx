'use client';

import { useState, useEffect, useRef } from 'react';
import { formatBytes } from '../../utils';
import { getAuth } from './detail/shared';
import { fetchUser, updatePassword } from '../../actions/user';
import {
  runVacuum,
  getMaintenanceStats,
  getBackupSettingsAction,
  updateBackupSettings,
  triggerManualBackup,
  preflightBackupDestination,
} from '../../actions/maintenance';
import { Toggle } from '../../components/Toggle';
import { LoadingState } from '../../components/LoadingState';

function SettingsSection({
  title,
  children,
  defaultOpen = true,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="card mb-6 group">
      <summary className="px-6 py-4 cursor-pointer select-none flex items-center justify-between list-none [&::-webkit-details-marker]:hidden">
        <h2 className="eyebrow font-semibold">{title}</h2>
        <svg
          className="w-4 h-4 text-text-tertiary transition-transform group-open:rotate-180"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </summary>
      <div className="px-6 pb-6">{children}</div>
    </details>
  );
}

interface UserInfo {
  username: string;
  createdAt: string;
}

interface MaintenanceStats {
  dbSize: number;
  tableCounts: Record<string, number>;
}

// CapacityCard + System Memory both moved to HostStatusStrip
// (click-to-expand) on /dashboard. They're observational, not configurational.

export default function Component() {
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);

  // Maintenance state
  const [maintenanceStats, setMaintenanceStats] = useState<MaintenanceStats | null>(null);
  const [maintenanceMessage, setMaintenanceMessage] = useState('');
  const [maintenanceError, setMaintenanceError] = useState('');
  const [vacuumRunning, setVacuumRunning] = useState(false);

  // Backup settings state
  const [backupEnabled, setBackupEnabled] = useState(false);
  const [backupDestination, setBackupDestination] = useState('/Volumes/CLOUD/deploy-backup');
  const [backupCron, setBackupCron] = useState('0 */6 * * *');
  const [backupStatus, setBackupStatus] = useState<{
    lastRunAt: string | null;
    lastSuccess: boolean | null;
    lastDurationMs: number | null;
    lastError: string | null;
    running: boolean;
  } | null>(null);
  const [backupSaving, setBackupSaving] = useState(false);
  const [backupMessage, setBackupMessage] = useState('');
  const [backupError, setBackupError] = useState('');
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupChecking, setBackupChecking] = useState(false);
  const [backupCheck, setBackupCheck] = useState<{
    ok: boolean;
    freeBytes: number | null;
    error?: string;
  } | null>(null);

  useEffect(() => {
    async function load() {
      const auth = getAuth();
      if (!auth) return;
      try {
        const data = await fetchUser(auth.username, auth.token);
        setUser(data as UserInfo);

        // Load maintenance stats + backup settings
        const [stats, backupData] = await Promise.all([
          getMaintenanceStats(auth.username, auth.token),
          getBackupSettingsAction(auth.username, auth.token),
        ]);
        setMaintenanceStats(stats as MaintenanceStats);
        if (backupData) {
          setBackupEnabled(backupData.settings.enabled);
          setBackupDestination(backupData.settings.destination);
          setBackupCron(backupData.settings.cron);
          setBackupStatus(backupData.status);
        }
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

  async function handleBackupSettingsSave() {
    setBackupMessage('');
    setBackupError('');
    setBackupSaving(true);

    try {
      const auth = getAuth();
      if (!auth) return;
      const result = await updateBackupSettings(auth.username, auth.token, {
        enabled: backupEnabled,
        destination: backupDestination,
        cron: backupCron,
      });
      setBackupMessage(result.message);
    } catch (err) {
      setBackupError((err as Error).message);
    } finally {
      setBackupSaving(false);
    }
  }

  async function handleBackupDestinationCheck() {
    setBackupMessage('');
    setBackupError('');
    setBackupCheck(null);
    setBackupChecking(true);
    try {
      const auth = getAuth();
      if (!auth) return;
      const result = await preflightBackupDestination(auth.username, auth.token, backupDestination);
      setBackupCheck(result);
      if (!result.ok) setBackupError(result.error || 'Destination check failed');
    } catch (err) {
      setBackupError((err as Error).message);
    } finally {
      setBackupChecking(false);
    }
  }

  async function handleManualBackup() {
    setBackupMessage('');
    setBackupError('');
    setBackupRunning(true);

    try {
      const auth = getAuth();
      if (!auth) return;
      const result = await triggerManualBackup(auth.username, auth.token);
      if (result.success) {
        setBackupMessage(`Backup completed in ${result.durationMs}ms`);
      } else {
        setBackupError(result.error || 'Backup failed');
      }
      // Refresh status
      const statusData = await getBackupSettingsAction(auth.username, auth.token);
      if (statusData) {
        setBackupStatus(statusData.status);
      }
    } catch (err) {
      setBackupError((err as Error).message);
    } finally {
      setBackupRunning(false);
    }
  }

  // Lazy-load cronstrue (~30KB) only when needed
  const cronstrueRef = useRef<(typeof import('cronstrue'))['default'] | null>(null);
  const [cronDescription, setCronDescription] = useState('');

  useEffect(() => {
    let cancelled = false;
    import('cronstrue').then((mod) => {
      if (cancelled) return;
      cronstrueRef.current = mod.default;
      try {
        setCronDescription(mod.default.toString(backupCron));
      } catch {
        setCronDescription('Invalid cron expression');
      }
    });
    return () => {
      cancelled = true;
    };
  }, [backupCron]);

  if (loading) {
    return <LoadingState />;
  }

  return (
    <div>
      <h1 className="prompt-h1 mb-6">Settings</h1>

      <SettingsSection title="Account">
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
      </SettingsSection>

      <SettingsSection title="Security" defaultOpen={false}>
        <form onSubmit={handlePasswordChange} className="flex flex-col gap-3 max-w-sm">
          <input
            type="password"
            placeholder="Current password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            className="input"
            required
            aria-label="Current password"
          />
          <input
            type="password"
            placeholder="New password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            className="input"
            required
            aria-label="New password"
          />
          <input
            type="password"
            placeholder="Confirm new password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            className="input"
            required
            aria-label="Confirm new password"
          />
          {error && <p className="text-xs text-danger">{error}</p>}
          {success && <p className="text-xs text-success">{success}</p>}
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving...' : 'Change Password'}
          </button>
        </form>
      </SettingsSection>

      <SettingsSection title="Backups">
        <div className="space-y-4 max-w-sm">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-sm">Enable periodic backup</span>
              <p className="text-xs text-text-tertiary">
                Syncs .deploy-data/ to an external destination via rsync
              </p>
            </div>
            <Toggle
              enabled={backupEnabled}
              onChange={() => setBackupEnabled(!backupEnabled)}
              label="Enable Backup"
            />
          </div>

          <div>
            <label className="text-xs text-text-secondary mb-1 block">Destination Path</label>
            <input
              type="text"
              value={backupDestination}
              onChange={(e) => setBackupDestination(e.target.value)}
              placeholder="/Volumes/CLOUD/deploy-backup"
              className="input w-full font-mono text-xs"
            />
            <p className="text-xs text-text-tertiary mt-1">
              Must be an absolute path. External volume mount recommended.
            </p>
            <button
              type="button"
              onClick={handleBackupDestinationCheck}
              disabled={backupChecking || !backupDestination.trim()}
              className="btn btn-sm mt-2"
            >
              {backupChecking ? 'Checking…' : 'Test destination'}
            </button>
            {backupCheck?.ok && (
              <p className="text-xs text-success mt-2 font-mono">
                Writable
                {backupCheck.freeBytes != null
                  ? ` · ${formatBytes(backupCheck.freeBytes)} available`
                  : ''}
              </p>
            )}
          </div>

          <div>
            <label className="text-xs text-text-secondary mb-1 block">Schedule (crontab)</label>
            <input
              type="text"
              value={backupCron}
              onChange={(e) => setBackupCron(e.target.value)}
              placeholder="0 */6 * * *"
              className="input w-full font-mono text-xs"
            />
            <p className="text-xs text-text-tertiary mt-1">{cronDescription}</p>
            <div className="flex flex-wrap gap-1.5 mt-2">
              {[
                { label: 'Hourly', cron: '0 * * * *' },
                { label: 'Every 6h', cron: '0 */6 * * *' },
                { label: 'Daily midnight', cron: '0 0 * * *' },
                { label: 'Weekly', cron: '0 0 * * 0' },
              ].map((preset) => (
                <button
                  key={preset.cron}
                  type="button"
                  onClick={() => setBackupCron(preset.cron)}
                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                    backupCron === preset.cron
                      ? 'border-accent text-accent bg-accent/10'
                      : 'border-border text-text-secondary hover:border-text-tertiary'
                  }`}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </div>

          <button
            onClick={handleBackupSettingsSave}
            disabled={backupSaving}
            className="btn btn-primary w-full"
          >
            {backupSaving ? 'Saving...' : 'Save Backup Settings'}
          </button>

          {backupMessage && <p className="text-xs text-success">{backupMessage}</p>}
          {backupError && <p className="text-xs text-danger">{backupError}</p>}

          <div className="border-t border-border pt-4">
            <button
              onClick={handleManualBackup}
              disabled={backupRunning || (backupStatus?.running ?? false)}
              className="btn btn-primary w-full mb-3"
            >
              {backupRunning || backupStatus?.running ? 'Backup Running...' : 'Backup Now'}
            </button>

            {backupStatus && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-secondary">Last backup</span>
                  <span className="text-xs font-mono">
                    {backupStatus.lastRunAt
                      ? new Date(backupStatus.lastRunAt).toLocaleString()
                      : 'Never'}
                  </span>
                </div>
                {backupStatus.lastSuccess !== null && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-secondary">Result</span>
                    <span
                      className={`text-xs font-mono ${
                        backupStatus.lastSuccess ? 'text-success' : 'text-danger'
                      }`}
                    >
                      {backupStatus.lastSuccess ? 'Success' : 'Failed'}
                      {backupStatus.lastDurationMs !== null &&
                        ` (${backupStatus.lastDurationMs}ms)`}
                    </span>
                  </div>
                )}
                {backupStatus.lastError && (
                  <p className="text-xs text-danger font-mono break-all">
                    {backupStatus.lastError}
                  </p>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-xs text-text-tertiary">
              Uses rsync with --delete flag. The destination will mirror .deploy-data/ exactly.
              SQLite WAL/SHM files are excluded. The destination volume must be mounted for backup
              to succeed.
            </p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection title="Maintenance" defaultOpen={false}>
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

          {maintenanceMessage && <p className="text-xs text-success">{maintenanceMessage}</p>}
          {maintenanceError && <p className="text-xs text-danger">{maintenanceError}</p>}

          <div className="border-t border-border pt-4">
            <p className="text-xs text-text-tertiary">
              <strong>Automated Maintenance:</strong> VACUUM and data retention run every 6 hours.
              Resource metrics are pruned after 30 days and request logs after 90 days. All other
              data (deployments, history, build logs) is preserved indefinitely.
            </p>
          </div>
        </div>
      </SettingsSection>
    </div>
  );
}
