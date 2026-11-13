'use client';
import { useEffect, useState } from 'react';
import { useLocation, useSearchParams } from 'react-flight-router/client';
import {
  Action,
  Banner,
  ChipSelect,
  Dialog,
  Empty,
  Glyph,
  Group,
  Icon,
  Item,
  Skeleton,
  Term,
} from '@/components/ui';
import type {
  Project,
  Release,
  Rollback,
  RollbackDataLoss,
} from '../../../../../shared/v2/contracts';
import { authenticatedFetch, eventFeed } from '../data/hooks';
import './releases.css';
import { projectPath } from '../projects/routing';
import { request as workspaceRequest } from '../projects/data';
import { formatTime } from '../data/time';
import { missingVariable } from './presentation';

async function request(path: string, options: RequestInit = {}) {
  const response = await authenticatedFetch(`/api/v2${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
  });
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(body.error || 'Request failed'), { dataLoss: body.dataLoss });
  return body;
}
function stateLabel(release: Release) {
  if (release.state === 'running') return 'Releasing';
  if (release.state === 'live') return 'Live';
  if (release.state === 'rolled-back') return 'Rolled back';
  if (release.state === 'superseded') return '';
  const failed = release.steps.find((step) => step.state === 'failed');
  return `${failed ? failed.name[0].toUpperCase() + failed.name.slice(1) : 'Release'} failed`;
}
function StepList({ steps }: { steps: Release['steps'] }) {
  return (
    <ul className="dl-steps" aria-label="Release progress">
      {steps.map((step) => (
        <li className="dl-step" key={step.name}>
          <span className="dl-i">
            <Icon
              name={
                step.state === 'done'
                  ? 'check'
                  : step.state === 'running'
                    ? 'running'
                    : step.state === 'waiting'
                      ? 'clock'
                      : 'close'
              }
              size={14}
              className={
                step.state === 'running' ? 'dl-run dl-spin' : step.state === 'done' ? 'dl-ok' : ''
              }
            />
          </span>
          <span className="dl-t">
            {step.name[0].toUpperCase() + step.name.slice(1)}
            {step.state === 'done'
              ? ' complete'
              : step.state === 'failed'
                ? ' failed'
                : step.state === 'skipped'
                  ? ' skipped'
                  : ''}
          </span>
          <span className="dl-x">
            {step.detail ||
              (step.startedAt && step.endedAt
                ? formatTime(step.startedAt, 'elapsed', new Date(step.endedAt))
                : step.state === 'running'
                  ? 'In progress'
                  : '')}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ReleaseOutput({
  release,
  logs,
  onShown,
}: {
  release: Release;
  logs: string;
  onShown: (id: string) => void;
}) {
  const [output, setOutput] = useState('');
  const shown = !!output.trim();
  // Its head carries Full log, so the page drops its own link while this is on screen.
  useEffect(() => {
    if (shown) onShown(release.id);
  }, [shown, release.id, onShown]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const body = await request(`/releases/${encodeURIComponent(release.id)}/output`, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) setOutput(body.output);
      } catch {
        // A transient read failure keeps the last received output; the next poll retries.
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(() => void refresh(), 2000);
      }
    }
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [release.id]);
  if (!shown) return null;
  return (
    <Group
      title="Output"
      end={
        <a className="dl-btn quiet" href={logs}>
          Full log
        </a>
      }
    >
      <Term aria-label="Release build output">{output}</Term>
    </Group>
  );
}

export default function Releases() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const appKey = searchParams.get('app');
  const segments = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const projectKey = segments[2],
    releaseId = segments[4];
  const [project, setProject] = useState<Project>();
  const [releases, setReleases] = useState<Release[]>();
  const [rollbacks, setRollbacks] = useState<Rollback[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [dialog, setDialog] = useState(false);
  const [outputFor, setOutputFor] = useState('');
  const [busy, setBusy] = useState(false);
  const [decisionError, setDecisionError] = useState('');
  const [dataLoss, setDataLoss] = useState<RollbackDataLoss>();
  const [targetId, setTargetId] = useState('');
  const base = projectPath(projectKey);
  const selectedApp = project?.apps.find((app) => app.name === appKey || app.id === appKey);
  const appQuery = selectedApp ? `?app=${encodeURIComponent(selectedApp.name)}` : '';
  const apiProject = `/projects/${encodeURIComponent(projectKey)}`;
  useEffect(() => {
    let loaded = false;
    setReleases(undefined);
    setProject(undefined);
    setError('');
    setDialog(false);
    async function sync(signal: AbortSignal) {
      try {
        const [projectsResponse, releaseResponse, rollbackResponse] = await Promise.all([
          request('/projects', { signal }),
          request(`${apiProject}/releases`, { signal }),
          request(`${apiProject}/rollbacks`, { signal }),
        ]);
        if (signal.aborted) return false;
        const projects: Project[] = projectsResponse.projects;
        const selected =
          projects.find((p) => p.id === projectKey) || projects.find((p) => p.name === projectKey);
        setProject(selected);
        setReleases(releaseResponse.releases);
        setRollbacks(rollbackResponse.rollbacks);
        setError('');
        loaded = true;
        return true;
      } catch (error) {
        if (!signal.aborted)
          setError(error instanceof Error ? error.message : 'Releases are unavailable');
        return false;
      }
    }
    return eventFeed.subscribe({
      snapshot: sync,
      async events(events, signal) {
        if (events.some((event) => event.type === 'release' || event.type === 'rollback'))
          if (!(await sync(signal))) throw new Error('Snapshot unavailable');
      },
      error(_reason, phase) {
        if (phase === 'connection' || !loaded)
          setError('Live updates are unavailable. Reconnecting…');
      },
      reset() {
        loaded = false;
        setReleases(undefined);
        setProject(undefined);
        setRollbacks([]);
        setError('');
        setDialog(false);
      },
    });
  }, [projectKey, apiProject, retry]);
  const selected =
    releases?.find((release) => release.id === releaseId) ||
    (!releaseId ? releases?.[0] : undefined);
  const rollback = rollbacks.find(
    (entry) => entry.from === selected?.id || entry.to === selected?.id,
  );
  const rolling = rollback?.steps.some(
    (step) => step.state === 'running' || step.state === 'waiting',
  );
  const candidates =
    releases?.filter(
      (release) =>
        release.id !== selected?.id && ['superseded', 'rolled-back'].includes(release.state),
    ) || [];
  const target = candidates.find((release) => release.id === targetId) || candidates[0];
  const untouched =
    selected?.state === 'failed' &&
    selected.steps.find((step) => step.name === 'activate')?.state === 'skipped';
  const failedStep = selected?.steps.find((step) => step.state === 'failed');
  async function fixInTask() {
    if (!selected || !project) return;
    setBusy(true);
    setError('');
    try {
      const task = await workspaceRequest('/api/workspace/tasks', {
        method: 'POST',
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          projectId: project.id,
          title: `Fix failed release ${selected.id.slice(0, 7)}`,
          prompt: `Fix release ${selected.id} (${selected.source.ref}). ${failedStep?.name || 'Release'} failed:\n${failedStep?.detail || 'See the release log.'}\nReview the failure and open a pull request with the fix.`,
        }),
      });
      window.location.assign(`/dashboard/tasks/${encodeURIComponent(task.id)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not start a task.');
    } finally {
      setBusy(false);
    }
  }
  async function rollBack() {
    if (!selected || !target) return;
    setBusy(true);
    setDecisionError('');
    try {
      const response = await request(`${apiProject}/rollback`, {
        method: 'POST',
        body: JSON.stringify({
          from: selected.id,
          to: target.id,
          ...(dataLoss ? { confirmBackupId: dataLoss.backupId } : {}),
        }),
      });
      setRollbacks((entries) => [response.rollback, ...entries]);
      setDialog(false);
      setDataLoss(undefined);
    } catch (error: any) {
      setDecisionError(error.message);
      setDataLoss(error.dataLoss);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="v2-releases-page">
        {error && (
          <Banner
            title={error}
            action={
              <Action variant="quiet" onClick={() => setRetry((n) => n + 1)}>
                Retry
              </Action>
            }
          />
        )}
        {!releases && !error && (
          <Skeleton rows={4} slowLabel="Releases are taking longer to load." />
        )}
        {releases?.length === 0 && (
          <Empty
            title="No releases yet"
            icon="folder"
            actions={
              <a className="dl-btn primary" href="/dashboard">
                New task
              </a>
            }
          >
            Releases move every app in this project together.
          </Empty>
        )}
        {!!releases?.length && (
          <div className="v2-releases-layout">
            <nav className="v2-releases-nav" aria-label="Releases">
              {releases.map((release) => (
                <a
                  className={`dl-nav ${selected?.id === release.id ? 'on' : ''}`}
                  aria-current={selected?.id === release.id ? 'page' : undefined}
                  key={release.id}
                  href={`${base}/releases/${encodeURIComponent(release.id)}${appQuery}`}
                >
                  <Icon name="send" size={14} />
                  <span className="dl-t">
                    <span className="dl-strong dl-mono">{release.id.slice(0, 7)}</span>
                    <span className="dl-meta">
                      {release.startedBy} ·{' '}
                      {release.source.kind === 'cli' ? 'from the CLI' : release.source.ref}
                    </span>
                  </span>
                  {stateLabel(release) && <span className="dl-tag">{stateLabel(release)}</span>}
                </a>
              ))}
            </nav>
            <section className="v2-release-detail" aria-label="Release detail">
              {!selected ? (
                <Empty title="Release not found">Select a release from this project.</Empty>
              ) : (
                <>
                  <div className="dl-page-head">
                    <div className="dl-t">
                      <h1 className="v2-release-title">{selected.source.ref}</h1>
                      <span className="dl-meta">
                        {selected.id.slice(0, 7)} · {selected.source.kind} · started by{' '}
                        {selected.startedBy}
                      </span>
                    </div>
                    {(selected.state === 'live' || (selected.state === 'failed' && !untouched)) &&
                      candidates.length > 0 && (
                        <Action
                          disabled={
                            busy ||
                            rolling ||
                            releases.some((release) => release.state === 'running')
                          }
                          onClick={() => {
                            setDialog(true);
                            setDataLoss(undefined);
                            setDecisionError('');
                            setTargetId('');
                          }}
                        >
                          Roll back release
                        </Action>
                      )}
                  </div>
                  {rollback && (
                    <div className="dl-approval v2-release-progress">
                      <div className="dl-approval-head">
                        <Glyph kind={rollback.approvedBy === 'rule' ? 'warden' : 'plain'}>
                          {rollback.approvedBy === 'rule' ? 'W' : <Icon name="clock" />}
                        </Glyph>
                        <div className="dl-t">
                          <p className="dl-approval-title">
                            {rolling
                              ? `Rolling back ${project?.name || projectKey}`
                              : rollback.steps.some((step) => step.state === 'failed')
                                ? 'Rollback needs attention'
                                : `${rollback.approvedBy === 'rule' ? 'Automatically rolled back' : 'Rolled back'} ${project?.name || projectKey} to ${rollback.to.slice(0, 7)}`}
                          </p>
                          <p className="dl-approval-text">{rollback.reason}</p>
                          <span className="dl-meta">
                            {rollback.approvedBy === 'rule'
                              ? `Allowed by rule ${rollback.ruleId}`
                              : `Approved by ${rollback.approvedBy}`}
                          </span>
                          <StepList steps={rollback.steps} />
                        </div>
                      </div>
                      {rollback.approvedBy === 'rule' && (
                        <div className="dl-approval-actions">
                          <a className="dl-btn quiet" href="/dashboard/settings/approvals">
                            Edit the rule
                          </a>
                        </div>
                      )}
                    </div>
                  )}
                  {selected.state === 'failed' && (
                    <Banner
                      kind="danger"
                      title={
                        untouched
                          ? `${failedStep?.name === 'verify' ? 'Verify' : 'Prepare'} failed. Nothing changed.`
                          : 'Release failed. Review the release before rolling back.'
                      }
                    >
                      {untouched
                        ? 'Every app stayed on its previous release.'
                        : 'The release log shows where work stopped.'}
                    </Banner>
                  )}
                  {(selected.state === 'running' || selected.state === 'failed') && (
                    <div className="dl-approval v2-release-progress">
                      {selected.state === 'running' && (
                        <div className="dl-approval-head">
                          <Icon name="running" className="dl-run dl-spin" size={18} />
                          <div className="dl-t">
                            <p className="dl-approval-title">
                              {selected.steps.find((step) => step.state === 'running')?.name ===
                              'verify'
                                ? 'Verifying'
                                : 'Releasing'}{' '}
                              {selected.id.slice(0, 7)}
                            </p>
                            <p className="dl-approval-text">
                              Every app is prepared and verified before activation.
                            </p>
                          </div>
                        </div>
                      )}
                      <StepList steps={selected.steps} />
                    </div>
                  )}
                  {selected.state === 'running' && (
                    <ReleaseOutput
                      key={selected.id}
                      release={selected}
                      logs={`${base}/logs${appQuery}`}
                      onShown={setOutputFor}
                    />
                  )}
                  {selected.state !== 'running' && (
                    <Term aria-label="Release log">
                      {selected.state === 'failed' && failedStep?.detail
                        ? failedStep.detail
                        : selected.steps
                            .map((step) => `[${step.name}]  ${step.detail || step.state}`)
                            .join('\n')}
                    </Term>
                  )}
                  {selected.state !== 'failed' && (
                    <Group title="In this release">
                      {selected.apps.map((app) => (
                        <Item
                          key={app.appId}
                          lead={
                            <Glyph kind="plain">
                              <Icon
                                name={
                                  project?.apps.find((entry) => entry.id === app.appId)?.kind ===
                                  'worker'
                                    ? 'computer'
                                    : 'folder'
                                }
                                size={12}
                              />
                            </Glyph>
                          }
                          description={`${app.from?.slice(0, 7) || 'First release'} → ${app.to.slice(0, 7)}`}
                          title={
                            project?.apps.find((entry) => entry.id === app.appId)?.name || app.appId
                          }
                        />
                      ))}
                      {selected.migrations.map((migration) => (
                        <Item
                          key={migration.id}
                          description={
                            migration.reversible
                              ? 'Reversible migration'
                              : 'Pre-release backup required'
                          }
                          title={migration.title}
                        />
                      ))}
                    </Group>
                  )}
                  <div className="v2-release-links">
                    {!(selected.state === 'running' && outputFor === selected.id) && (
                      <a className="dl-btn quiet" href={`${base}/logs`}>
                        Full log
                      </a>
                    )}
                    {selected.state === 'failed' && (
                      <>
                        <a
                          className="dl-btn primary"
                          href={`${base}/settings${missingVariable(failedStep?.detail) ? `?key=${encodeURIComponent(missingVariable(failedStep?.detail)!)}` : ''}`}
                        >
                          {missingVariable(failedStep?.detail)
                            ? 'Add the variable'
                            : 'Project settings'}
                        </a>
                        <Action disabled={!project || busy} onClick={() => void fixInTask()}>
                          Fix it in a task
                        </Action>
                      </>
                    )}
                  </div>
                  {selected.state === 'running' && (
                    <span className="dl-meta">
                      You can leave this page. Progress is saved with the release.
                    </span>
                  )}
                </>
              )}
            </section>
          </div>
        )}
      </div>
      <Dialog
        open={dialog}
        onClose={() => {
          if (!busy) setDialog(false);
        }}
        title={`Roll back ${project?.name || projectKey}?`}
        actions={
          <>
            <Action disabled={busy} onClick={() => setDialog(false)}>
              Cancel
            </Action>
            <Action
              variant={dataLoss ? 'danger' : 'primary'}
              loading={busy}
              disabled={!target}
              onClick={() => void rollBack()}
            >
              {dataLoss ? 'Restore backup and roll back' : 'Roll back release'}
            </Action>
          </>
        }
      >
        <p>Every app will move together from {selected?.id.slice(0, 7)} to the selected release.</p>
        <label className="v2-release-target">
          Target release
          <ChipSelect
            label="Target release"
            value={target?.id || ''}
            onChange={(value) => {
              setTargetId(value);
              setDataLoss(undefined);
              setDecisionError('');
            }}
            disabled={busy}
            options={candidates.map((release) => ({
              value: release.id,
              label: `${release.id.slice(0, 7)} · ${release.source.ref}`,
            }))}
          />
        </label>
        {selected?.migrations.length ? (
          <ul>
            {selected.migrations.map((migration) => (
              <li key={migration.id}>
                {migration.title} ·{' '}
                {migration.reversible ? 'will be reversed' : 'requires a backup restore'}
              </li>
            ))}
          </ul>
        ) : null}
        {dataLoss && (
          <Banner kind="danger" title="Data after this backup will be lost">
            {dataLoss.summary}
          </Banner>
        )}
        {decisionError && !dataLoss && <Banner kind="danger" title={decisionError} />}
      </Dialog>
    </>
  );
}
