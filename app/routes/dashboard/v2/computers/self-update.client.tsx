'use client';
import { useState, type ReactNode } from 'react';
import { Action, Banner, Group, Icon, Item, Steps, Term } from '@/components/ui';
import { relativeTime } from '../data/sidebar';
import { getAuth } from '../../detail/shared';
import { selfUpdateLog, startSelfUpdate } from '../data/self-update';
import {
  changeCount,
  failedNotice,
  minutes,
  pageMeta,
  plannedSteps,
  runningNotice,
  short,
  updateSteps,
  type SelfUpdateView,
} from './self-update-presentation';

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">{title}</h2>
      <div className="computers-section-body">{children}</div>
    </section>
  );
}
function Changes({ title, view }: { title: string; view: SelfUpdateView }) {
  const { changes, ahead } = view.status;
  return (
    <Section title={title}>
      <Group>
        {changes.map((change) => (
          <Item
            key={change.sha}
            title={change.subject}
            description={`${short(change.sha)} · ${ago(change.date)}`}
          />
        ))}
      </Group>
      {ahead > changes.length && (
        <p className="dl-meta computers-description">
          and {changeCount(ahead - changes.length)} more
        </p>
      )}
    </Section>
  );
}
function ago(at: string) {
  const time = relativeTime(at);
  if (time === 'now') return 'just now';
  if (time === '1d') return 'yesterday';
  return `${time.slice(0, -1)} ${time.slice(-1)} ago`;
}

/** deploy.local updating the coordinator to its own main: available, running or failed. */
export function SelfUpdatePanel({ view, offline }: { view: SelfUpdateView; offline: boolean }) {
  const { status } = view;
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState('');
  const [log, setLog] = useState<string | null>(null);
  const start = async () => {
    setStarting(true);
    setError('');
    try {
      await startSelfUpdate(status.main);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The update could not start.');
    } finally {
      setStarting(false);
    }
  };
  const showLog = async () => {
    if (log !== null) return setLog(null);
    try {
      setLog((await selfUpdateLog()) || 'Nothing was logged.');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'The log is unavailable.');
    }
  };
  return (
    <>
      <div className="dl-page-head">
        <div className="dl-t">
          <h1 className="dl-title">deploy.local updates</h1>
          <span className="dl-meta">{pageMeta(view)}</span>
        </div>
      </div>
      {error && <Banner kind="danger" title={error} />}
      {view.kind === 'available' ? (
        <div className="dl-notice">
          <Icon name="update" />
          <span>
            main has {changeCount(status.ahead)} {status.computer} is not running yet. Updating
            takes about {minutes(status.estimateMs)}. Tasks on other computers keep running; a task
            running on {status.computer} stops when it restarts.
          </span>
          <span className="dl-end">
            <Action variant="primary" loading={starting} onClick={start}>
              Update {status.computer}
            </Action>
          </span>
        </div>
      ) : view.kind === 'running' ? (
        <div className="dl-notice">
          <Icon name="running" className="dl-run" />
          <span>
            {offline
              ? `${status.computer} is restarting. This page reconnects by itself.`
              : runningNotice(view.run, status, getAuth()?.username || '')}
          </span>
        </div>
      ) : (
        <div className="dl-notice">
          <Icon name="failed" className="dl-fail" />
          <span>{failedNotice(view.run, status)}</span>
          <span className="dl-end computers-row-end">
            <Action variant="quiet" onClick={showLog}>
              {log === null ? 'Show log' : 'Hide log'}
            </Action>
            <Action variant="primary" loading={starting} onClick={start}>
              Try again
            </Action>
          </span>
        </div>
      )}
      {log !== null && <Term className="wrap">{log}</Term>}
      {view.kind === 'available' ? (
        <>
          <Changes title="New on main" view={view} />
          <Section title="What updating does">
            <Steps steps={plannedSteps(status)} />
          </Section>
        </>
      ) : (
        <>
          <Section title={view.kind === 'running' ? 'Progress' : 'What happened'}>
            <Steps steps={updateSteps(view.run.steps, status, view.run.from)} />
          </Section>
          <Changes
            title={view.kind === 'running' ? 'In this update' : 'Not installed'}
            view={view}
          />
        </>
      )}
    </>
  );
}
