'use client';
import { useEffect, useRef, useState } from 'react';
import cronstrue from 'cronstrue';
import { Action, Banner, Dialog, Empty, Field, Group, Icon, Item, Skeleton } from '@/components/ui';
import type {
  BackupPoint,
  BackupRestore,
  BackupsResponse,
} from '../../../../../../shared/v2/contracts';
import { request } from '../../agents/shared';
import { SettingsFrame } from '../frame.client';
import './style.css';
import { useProjectFormatting } from '../../projects/formatting';
import { useDataSeed, readSeeded } from '../../data/seeds';
import { authenticatedFetch } from '../../data/hooks';
import { allCopiesLocal } from './presentation';

function bytes(value: number | null) {
  if (value === null) return 'Size unavailable';
  for (const [unit, divisor] of [
    ['GB', 1e9],
    ['MB', 1e6],
    ['KB', 1e3],
  ] as const)
    if (value >= divisor) return `${Number((value / divisor).toFixed(1))} ${unit}`;
  return `${value} B`;
}
const kind = (point: BackupPoint) =>
  point.kind === 'pre-release'
    ? `Before release ${point.releaseId}`
    : point.kind === 'scheduled'
      ? 'Scheduled backup'
      : point.kind === 'recovery'
        ? 'Encrypted recovery bundle'
        : 'Manual backup';
function scheduleLabel(schedule: string) {
  try {
    return cronstrue.toString(schedule);
  } catch {
    return 'Schedule unavailable';
  }
}
const path = (id: string) => `/backups/${encodeURIComponent(id)}`;

export default function Backups() {
  const seed = useDataSeed();
  const { formatTime } = useProjectFormatting();
  const date = (value?: string) =>
    value ? `${formatTime(value, 'day')}, ${formatTime(value, 'clock')}` : 'Not yet';
  const [data, setData] = useState<BackupsResponse | undefined>(
    () => seed?.data['/api/backups'] as BackupsResponse | undefined,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<BackupPoint>();
  const [restore, setRestore] = useState<BackupRestore>();
  const [testPoint, setTestPoint] = useState<BackupPoint>();
  const [passphrase, setPassphrase] = useState('');
  const [notice, setNotice] = useState('');
  const retry = useRef<() => Promise<void>>(async () => {});
  async function refresh() {
    const result: BackupsResponse = await request('/backups');
    setData(result);
    setSelected((previous) =>
      previous ? result.backups.find((row) => row.id === previous.id) || previous : previous,
    );
    setRestore((previous) =>
      previous ? result.restores.find((row) => row.id === previous.id) || previous : previous,
    );
    return result;
  }
  useEffect(() => {
    let active = true;
    readSeeded(seed, '/api/backups', () => request('/backups'))
      .then((result: BackupsResponse) => {
        if (!active) return;
        setData(result);
        const id = new URLSearchParams(window.location.search).get('restore');
        if (id) setSelected(result.backups.find((point) => point.id === id));
      })
      .catch((error) => {
        if (active) {
          retry.current = async () => {};
          setError(error.message);
        }
      });
    return () => {
      active = false;
    };
  }, [seed]);
  useEffect(() => {
    if (!data?.restores.some((row) => ['creating', 'switching'].includes(row.state))) return;
    const timer = setInterval(() => {
      void refresh().catch((error) => {
        retry.current = async () => {};
        setError(error.message);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [data]);
  async function act(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    let completed = false;
    try {
      await work();
      completed = true;
      await refresh();
    } catch (error) {
      // A failed read must not repeat a mutation that already succeeded.
      retry.current = completed ? async () => {} : work;
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  function open(point: BackupPoint, current?: BackupRestore) {
    setError('');
    setSelected(point);
    setRestore(current);
  }
  function close() {
    if (!busy) {
      setSelected(undefined);
      setRestore(undefined);
      setError('');
    }
  }
  const latest = data?.backups[0];
  const tested = data?.backups
    .filter((point) => point.testedAt)
    .sort((a, b) => b.testedAt!.localeCompare(a.testedAt!))[0];
  const groups = [...new Set(data?.backups.map((point) => point.projectId || point.name))];
  const choices = data?.backups.filter(
    (point) =>
      selected && (point.projectId || point.name) === (selected.projectId || selected.name),
  );
  const testButton = (point: BackupPoint) => (
    <Action
      variant="quiet"
      disabled={busy || (!point.restoreAvailable && point.kind !== 'recovery')}
      onClick={() => {
        setPassphrase('');
        setTestPoint(point);
        setError('');
      }}
    >
      Test-restore now
    </Action>
  );
  return (
    <>
      <SettingsFrame>
        <div className="dl-backups-content">
          {error && !selected && !testPoint && (
            <Banner
              kind="danger"
              title="Backups could not complete"
              action={
                <Action variant="quiet" disabled={busy} onClick={() => void act(retry.current)}>
                  Try again
                </Action>
              }
            >
              {error}
            </Banner>
          )}
          {notice && <Banner title={notice} />}
          {!data ? (
            <Skeleton rows={4} slowLabel="Backups are taking longer to load." />
          ) : (
            <>
              <section className="dl-section">
                <h2 className="dl-section-title">Backups</h2>
                <p className="dl-section-sub">
                  Your app data, scheduled copies and backups taken before releases that change
                  data.
                </p>
                <Group>
                  <Item
                    end={
                      <Action
                        variant="quiet"
                        disabled={busy || !data.schedules.length}
                        onClick={() =>
                          void act(async () => {
                            const response = await authenticatedFetch('/api/backups/run', {
                              method: 'POST',
                            });
                            const result = await response.json();
                            if (!response.ok)
                              throw new Error(result.error || 'Backup could not start.');
                            setNotice('Backup complete.');
                          })
                        }
                      >
                        Back up now
                      </Action>
                    }
                    title="Last backup"
                    lead={<Icon name={latest ? 'check' : 'clock'} />}
                    description={
                      latest
                        ? `${date(latest.createdAt)} · ${latest.name} · ${bytes(latest.sizeBytes)}`
                        : 'No backups yet'
                    }
                  />
                  <Item
                    title="Last restore test"
                    lead={<Icon name={tested?.testStatus === 'passed' ? 'check' : 'clock'} />}
                    description={
                      tested
                        ? `${date(tested.testedAt)} · ${tested.name} · ${tested.testStatus}`
                        : 'No restore has been tested yet'
                    }
                  >
                    {latest && testButton(latest)}
                  </Item>
                </Group>
              </section>
              <section className="dl-section">
                <h2 className="dl-section-title">Where backups go</h2>
                <Group>
                  {data.schedules.map((schedule) => (
                    <Item
                      key={schedule.name}
                      title={schedule.name}
                      description={`${schedule.destination} · ${schedule.contents}`}
                      end={schedule.enabled ? scheduleLabel(schedule.schedule) : 'Not scheduled'}
                    />
                  ))}
                  {[...new Set(data.backups.map((point) => point.destination))]
                    .filter(
                      (destination) =>
                        !data.schedules.some((schedule) => schedule.destination === destination),
                    )
                    .map((destination) => (
                      <Item key={destination} title={destination} description="Backup folder" />
                    ))}
                  {!data.schedules.length && !data.backups.length && (
                    <Item title="No backup destination available" />
                  )}
                </Group>
              </section>
              <section className="dl-section">
                {allCopiesLocal(data) && (
                  <Banner title="Every copy is in this house">
                    A fire or theft could take your computers together. Add a copy somewhere else.
                  </Banner>
                )}
                <h2 className="dl-section-title">What is backed up</h2>
                {!groups.length ? (
                  <Empty title="No backups yet">
                    Backups appear here after a scheduled job or a release saves your app data.
                  </Empty>
                ) : (
                  <Group>
                    {groups.map((key) => {
                      const points = data.backups.filter(
                        (point) => (point.projectId || point.name) === key,
                      );
                      const point = points[0];
                      return (
                        <Item
                          key={key}
                          title={point.name}
                          lead={<Icon name="folder" />}
                          description={`${point.contents.join(', ')} · ${points.length} kept · from ${point.computer} · last saved ${date(point.createdAt)} · ${point.testStatus === 'untested' ? 'not test-restored' : `restore test ${point.testStatus}`}`}
                          end={bytes(point.sizeBytes)}
                        >
                          <Action variant="quiet" onClick={() => open(point)}>
                            Restore…
                          </Action>
                        </Item>
                      );
                    })}
                  </Group>
                )}
              </section>
              {data.restores.some((row) => row.state !== 'cancelled') && (
                <section className="dl-section">
                  <h2 className="dl-section-title">Restore copies</h2>
                  <Group>
                    {data.restores
                      .filter((row) => row.state !== 'cancelled')
                      .map((row) => (
                        <Item
                          key={row.id}
                          title={
                            data.backups.find((point) => point.id === row.backupId)?.name ||
                            row.projectId
                          }
                          description={
                            row.state === 'live'
                              ? 'Live · previous data is kept in a backup'
                              : row.error || `Copy ${row.state}`
                          }
                        >
                          <Action
                            variant="quiet"
                            onClick={() => {
                              const point = data.backups.find((point) => point.id === row.backupId);
                              if (point) open(point, row);
                            }}
                          >
                            Review
                          </Action>
                        </Item>
                      ))}
                  </Group>
                </section>
              )}
              <section className="dl-section">
                <h2 className="dl-section-title">If your coordinator is lost</h2>
                <p className="dl-section-sub">
                  Install deploy.local on a new computer, choose “Recover from a backup”, and enter
                  your recovery passphrase. Test a recovery bundle here before you need it.
                </p>
                <Group>
                  {data.backups
                    .filter((point) => point.kind === 'recovery')
                    .slice(0, 1)
                    .map((point) => (
                      <Item
                        key={point.id}
                        title="Recovery passphrase"
                        description="Use your passphrase to verify and test-restore the encrypted bundle."
                      >
                        {testButton(point)}
                      </Item>
                    ))}
                </Group>
              </section>
            </>
          )}
        </div>
      </SettingsFrame>
      <Dialog
        open={!!selected}
        onClose={close}
        title={
          restore ? `Check ${selected?.name}'s restored copy` : `Restore ${selected?.name}'s data?`
        }
        actions={
          <>
            <Action
              variant="quiet"
              disabled={busy}
              onClick={() =>
                restore?.state === 'ready' || (restore?.state === 'failed' && !restore.releaseId)
                  ? void act(async () => {
                      await request(
                        `${path(restore.backupId)}/restore/${restore.id}/cancel`,
                        'POST',
                      );
                      setSelected(undefined);
                      setRestore(undefined);
                    })
                  : close()
              }
            >
              {restore && ['ready', 'failed'].includes(restore.state) && !restore.releaseId
                ? 'Cancel restore'
                : 'Close'}
            </Action>
            {!restore && selected?.restoreAvailable && (
              <Action
                variant="primary"
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await request(`${path(selected.id)}/restore`, 'POST');
                    setRestore(result.restore);
                  })
                }
              >
                Restore to a copy
              </Action>
            )}
            {restore?.state === 'ready' && (
              <Action
                variant="primary"
                loading={busy}
                onClick={() =>
                  void act(async () => {
                    const result = await request(
                      `${path(restore.backupId)}/restore/${restore.id}/switch`,
                      'POST',
                      { confirm: true },
                    );
                    setRestore(result.restore);
                  })
                }
              >
                I checked it · Switch
              </Action>
            )}
          </>
        }
      >
        <div className="dl-backup-dialog">
          {error && (
            <Banner kind="danger" title="Restore could not complete">
              {error}
            </Banner>
          )}
          {!restore ? (
            <>
              <fieldset disabled={busy}>
                <legend className="dl-field-label">Restore to</legend>
                <Group>
                  {choices?.map((point) => (
                    <label className="dl-item" key={point.id}>
                      <input
                        type="radio"
                        name="backup"
                        value={point.id}
                        checked={selected?.id === point.id}
                        onChange={() => setSelected(point)}
                      />
                      <span className="dl-t">
                        <span>{date(point.createdAt)}</span>
                        <span>
                          {kind(point)} · {bytes(point.sizeBytes)}
                        </span>
                      </span>
                      {point.kind === 'pre-release' && (
                        <span className="dl-c">Before the release</span>
                      )}
                    </label>
                  ))}
                </Group>
              </fieldset>
              <div className="dl-scope">
                <div>
                  <span className="dl-k">Check first</span>
                  <span>Start the app from this backup beside the live one.</span>
                </div>
                <div>
                  <span className="dl-k">Switch</span>
                  <span>
                    Check the copy, then switch the project. Apps pause while data changes.
                  </span>
                </div>
                <div>
                  <span className="dl-k">Undo</span>
                  <span>Today's live data is backed up before switching and kept afterwards.</span>
                </div>
              </div>
              {selected && (
                <p className="dl-section-sub">
                  {selected.testStatus === 'untested'
                    ? 'Not test-restored yet.'
                    : `Restore test ${selected.testStatus} · ${date(selected.testedAt)}`}
                </p>
              )}
              {!selected?.restoreAvailable && (
                <Banner title="Restore to a copy is unavailable">
                  {selected?.unavailableReason}
                </Banner>
              )}
              <div className="dl-notice">
                <Icon name="clock" />
                <span>
                  This restores data only. Writes made since {date(selected?.createdAt)} stay in the
                  saved live backup. To move code back too, roll back the release.
                </span>
              </div>
              {selected && testButton(selected)}
            </>
          ) : (
            <>
              <p className="dl-section-sub">
                {restore.state === 'ready'
                  ? 'Open the copy and check your data. The live app has not changed.'
                  : restore.state === 'live'
                    ? 'The restored data is Live. The previous live data remains in its backup.'
                    : restore.error ||
                      `Restore ${restore.state}. You can close this dialog and return here.`}
              </p>
              <Group>
                {restore.state === 'ready' &&
                  restore.addresses.map((address) => (
                    <a
                      key={address.app}
                      className="dl-item"
                      href={address.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span className="dl-t">Open {address.app}'s copy</span>
                      <Icon name="chevron" />
                    </a>
                  ))}
              </Group>
              {restore.state === 'ready' &&
                restore.addresses.some(
                  (address) => new URL(address.url).hostname === 'localhost',
                ) && (
                  <p className="dl-section-sub">
                    Open this copy in a browser on the coordinator. Access from another computer or
                    iPhone is not available yet.
                  </p>
                )}
              {restore.releaseId && (
                <a
                  href={`/dashboard/projects/${encodeURIComponent(restore.projectId)}/releases/${encodeURIComponent(restore.releaseId)}`}
                >
                  View release progress
                </a>
              )}
              {restore.retainedBackupId && (
                <p className="dl-section-sub">Previous live backup: {restore.retainedBackupId}</p>
              )}
            </>
          )}
        </div>
      </Dialog>
      <Dialog
        open={!!testPoint}
        onClose={() => {
          if (!busy) {
            setTestPoint(undefined);
            setPassphrase('');
          }
        }}
        title={`Test-restore ${testPoint?.name}`}
        actions={
          <>
            <Action
              variant="quiet"
              disabled={busy}
              onClick={() => {
                setTestPoint(undefined);
                setPassphrase('');
              }}
            >
              Cancel
            </Action>
            <Action
              variant="primary"
              loading={busy}
              onClick={() =>
                void act(async () => {
                  await request(`${path(testPoint!.id)}/test`, 'POST', { passphrase });
                  setPassphrase('');
                  setTestPoint(undefined);
                  setNotice('Restore test passed');
                })
              }
            >
              Test-restore now
            </Action>
          </>
        }
      >
        <div className="dl-backup-dialog">
          {error && (
            <Banner kind="danger" title="Restore test failed">
              {error}
            </Banner>
          )}
          <p>
            Restore into a temporary copy, check it, then remove the copy. Your live data stays in
            place.
          </p>
          {testPoint?.kind === 'recovery' && (
            <Field
              label="Recovery passphrase"
              type="password"
              autoComplete="off"
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          )}
        </div>
      </Dialog>
    </>
  );
}
