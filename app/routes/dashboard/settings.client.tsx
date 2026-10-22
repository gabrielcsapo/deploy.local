'use client';

import { createContext, useContext, useState, useEffect, useRef } from 'react';
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
import { ListGroup, ListPageHeader, PropertyRow, Button } from '../../components/ui';
import { LoadingState, ErrorBanner } from '../../components/LoadingState';
import ProviderSettings from './provider-settings.client';

const SettingsCategory = createContext('settings-account');

function SettingsSection({ title, children }: { title: string; children: React.ReactNode }) {
  const active = useContext(SettingsCategory);
  const id = 'settings-' + title.toLowerCase().replace(/[^a-z]+/g, '-');
  return (
    <section id={id} className="ds-settings-section" hidden={active !== id} aria-label={title}>
      <ListGroup title={title}>
        <div className="ds-settings-content">{children}</div>
      </ListGroup>
    </section>
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

interface AdmissionState {
  active: number;
  queued: number;
  limit: number;
  activeDeployments: string[];
  queue: Array<{ name: string; position: number }>;
}

// CapacityCard + System Memory both moved to HostStatusStrip
// (click-to-expand) on /dashboard. They're observational, not configurational.

export default function Component() {
  const [category, setCategory] = useState('settings-account');
  const [loadError, setLoadError] = useState('');
  useEffect(() => {
    const change = () => {
      const next = window.location.hash.slice(1);
      setCategory(
        [
          'settings-account',
          'settings-security',
          'settings-providers',
          'settings-deployment-admission',
          'settings-backups',
          'settings-maintenance',
        ].includes(next)
          ? next
          : 'settings-account',
      );
    };
    change();
    window.addEventListener('hashchange', change);
    return () => window.removeEventListener('hashchange', change);
  }, []);
  const [user, setUser] = useState<UserInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [admission, setAdmission] = useState<AdmissionState | null>(null);
  const [cancellingDeploy, setCancellingDeploy] = useState<string | null>(null);

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
      } catch (failure) {
        setLoadError(failure instanceof Error ? failure.message : 'Settings could not be loaded.');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  async function handleCancelQueuedDeploy(name: string) {
    const auth = getAuth();
    if (!auth || cancellingDeploy) return;
    setCancellingDeploy(name);
    try {
      const response = await fetch(`/api/deploy-admission/${encodeURIComponent(name)}`, {
        method: 'DELETE',
        headers: {
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
      });
      if (!response.ok) throw new Error('Unable to cancel queued deploy');
      setAdmission((current) =>
        current
          ? {
              ...current,
              queued: Math.max(0, current.queued - 1),
              queue: current.queue.filter((item) => item.name !== name),
            }
          : current,
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setCancellingDeploy(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const loadAdmission = async () => {
      const auth = getAuth();
      if (!auth) return;
      try {
        const response = await fetch('/api/deploy-admission', {
          headers: {
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
        });
        if (response.ok && !cancelled) setAdmission((await response.json()) as AdmissionState);
      } catch {
        // The control plane may be restarting; the next poll will recover.
      }
    };
    void loadAdmission();
    const timer = window.setInterval(loadAdmission, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
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
    <SettingsCategory value={category}>
      <div className="ds-settings">
        {loadError && (
          <ErrorBanner
            message={loadError}
            action={
              <button className="ui-button ui-button-link" onClick={() => window.location.reload()}>
                Reload settings
              </button>
            }
          />
        )}

        <SettingsSection title="Providers">
          <ProviderSettings />
        </SettingsSection>
        <SettingsSection title="Account">
          <PropertyRow label="Username">{user?.username ?? 'Unavailable'}</PropertyRow>
          <PropertyRow label="Member since">
            {user?.createdAt ? new Date(user.createdAt).toLocaleDateString() : 'Unavailable'}
          </PropertyRow>
        </SettingsSection>

        <SettingsSection title="Security">
          <form onSubmit={handlePasswordChange} className="flex flex-col gap-3">
            <ListPageHeader>
              <Button variant="primary" type="submit" disabled={saving}>
                {saving ? 'Saving…' : 'Change password'}
              </Button>
            </ListPageHeader>
            <PropertyRow label="Current password">
              <input
                type="password"
                placeholder="Current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                className="input"
                required
                aria-label="Current password"
              />
            </PropertyRow>
            <PropertyRow label="New password">
              <input
                type="password"
                placeholder="New password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                className="input"
                required
                aria-label="New password"
              />
            </PropertyRow>
            <PropertyRow label="Confirm new password">
              <input
                type="password"
                placeholder="Confirm new password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="input"
                required
                aria-label="Confirm new password"
              />
            </PropertyRow>
            {error && <p className="text-xs text-danger">{error}</p>}
            {success && <p className="text-xs text-success">{success}</p>}
          </form>
        </SettingsSection>

        <SettingsSection title="Deployment admission">
          <div className="space-y-3 max-w-lg">
            <div>
              {[
                ['Running', admission?.active ?? 'Unavailable'],
                ['Queued', admission?.queued ?? 'Unavailable'],
                ['Global limit', admission?.limit ?? '—'],
              ].map(([label, value]) => (
                <PropertyRow key={String(label)} label={label}>
                  {value}
                </PropertyRow>
              ))}
            </div>
            {admission && admission.activeDeployments.length > 0 && (
              <div>
                <p className="text-xs text-text-secondary mb-1">Building now</p>
                <p className="text-xs font-mono">{admission.activeDeployments.join(', ')}</p>
              </div>
            )}
            {admission && admission.queue.length > 0 && (
              <div>
                <p className="text-xs text-text-secondary mb-1">Queue</p>
                <ol className="space-y-1">
                  {admission.queue.map((item) => (
                    <li
                      key={`${item.name}-${item.position}`}
                      className="flex items-center justify-between gap-3 text-xs font-mono"
                    >
                      <span>
                        {item.position}. {item.name}
                      </span>
                      <button
                        type="button"
                        className="ui-button ui-button-link"
                        disabled={cancellingDeploy === item.name}
                        onClick={() => handleCancelQueuedDeploy(item.name)}
                      >
                        {cancellingDeploy === item.name ? 'Cancelling…' : 'Cancel'}
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
            <p className="text-xs text-text-tertiary">
              Deploys for the same app are serialized. Set DEPLOY_BUILD_CONCURRENCY on the service
              to change the global build limit.
            </p>
          </div>
        </SettingsSection>

        <SettingsSection title="Backups">
          <ListPageHeader>
            <Button variant="primary" onClick={handleBackupSettingsSave} disabled={backupSaving}>
              {backupSaving ? 'Saving…' : 'Save backup settings'}
            </Button>
          </ListPageHeader>
          <div className="space-y-4">
            <PropertyRow
              label={
                <div>
                  <span className="text-sm">Enable periodic backup</span>
                  <p className="text-xs text-text-tertiary">
                    Pulls opted-in app volumes from every online node, then syncs .deploy-data/ via
                    rsync
                  </p>
                </div>
              }
            >
              <Toggle
                enabled={backupEnabled}
                onChange={() => setBackupEnabled(!backupEnabled)}
                label="Enable Backup"
              />
            </PropertyRow>

            <div>
              <PropertyRow label="Destination path">
                <input
                  type="text"
                  aria-label="Destination path"
                  value={backupDestination}
                  onChange={(e) => setBackupDestination(e.target.value)}
                  placeholder="/Volumes/CLOUD/deploy-backup"
                  className="input w-full font-mono text-xs"
                />
              </PropertyRow>
              <p className="text-xs text-text-tertiary mt-1">
                Must be an absolute path. External volume mount recommended.
              </p>
              <button
                type="button"
                onClick={handleBackupDestinationCheck}
                disabled={backupChecking || !backupDestination.trim()}
                className="ui-button ui-button-link mt-2"
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
              <PropertyRow label="Schedule (crontab)">
                <input
                  type="text"
                  aria-label="Schedule (crontab)"
                  value={backupCron}
                  onChange={(e) => setBackupCron(e.target.value)}
                  placeholder="0 */6 * * *"
                  className="input w-full font-mono text-xs"
                />
              </PropertyRow>
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
                    className="ui-button ui-button-link"
                    aria-pressed={backupCron === preset.cron}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            {backupMessage && <p className="text-xs text-success">{backupMessage}</p>}
            {backupError && <p className="text-xs text-danger">{backupError}</p>}

            <div className="border-t border-border pt-4">
              <button
                onClick={handleManualBackup}
                disabled={backupRunning || (backupStatus?.running ?? false)}
                className="ui-button ui-button-link mb-3"
              >
                {backupRunning || backupStatus?.running ? 'Backup Running...' : 'Backup Now'}
              </button>

              {backupStatus && (
                <div className="space-y-2">
                  <div className="ui-property-row">
                    <span className="text-xs text-text-secondary">Last backup</span>
                    <span className="text-xs font-mono">
                      {backupStatus.lastRunAt
                        ? new Date(backupStatus.lastRunAt).toLocaleString()
                        : 'Never'}
                    </span>
                  </div>
                  {backupStatus.lastSuccess !== null && (
                    <div className="ui-property-row">
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

        <SettingsSection title="Maintenance">
          <ListPageHeader>
            <Button variant="primary" onClick={handleVacuum} disabled={vacuumRunning}>
              {vacuumRunning ? 'Running VACUUM…' : 'Run database VACUUM'}
            </Button>
          </ListPageHeader>
          {maintenanceStats && (
            <div className="mb-6 space-y-3">
              <div className="ui-property-row">
                <span className="text-xs text-text-secondary">Database Size</span>
                <span className="text-sm font-mono">{formatBytes(maintenanceStats.dbSize)}</span>
              </div>

              <div className="border-t border-border pt-3">
                <p className="text-xs text-text-tertiary mb-2">Table Row Counts</p>
                <div className="ds-maintenance-counts">
                  {Object.entries(maintenanceStats.tableCounts).map(([table, count]) => (
                    <div key={table} className="ui-property-row">
                      <span className="text-xs text-text-secondary font-mono">{table}</span>
                      <span className="text-xs font-mono">{count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <div>
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
    </SettingsCategory>
  );
}
