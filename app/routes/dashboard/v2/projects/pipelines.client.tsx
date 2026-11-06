'use client';
import { useEffect, useRef, useState } from 'react';
import {
  Action,
  Banner,
  Dialog,
  Group,
  Icon,
  Item,
  Setting,
  Skeleton,
  Term,
} from '@/components/ui';
import { request, useData } from './data';
import { formatTime } from '../data/time';
import './pipelines.css';
const elapsed = (start?: string, end?: string) => {
  if (!start || !end) return '';
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  return seconds < 60
    ? `${seconds} s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};
export function ProjectPipelines({ projectId }: { projectId: string }) {
  const path = `/api/workspace/projects/${encodeURIComponent(projectId)}/pipelines`;
  const runs = useData<any>(path);
  const [selected, setSelected] = useState<string>();
  const selectedId = selected || runs.data?.runs[0]?.id;
  const detail = useData<any>(selectedId ? `${path}/${encodeURIComponent(selectedId)}` : undefined);
  const [log, setLog] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const refresh = useRef(() => {});
  refresh.current = () => {
    runs.refresh();
    detail.refresh();
  };
  useEffect(() => {
    const timer = setInterval(() => {
      refresh.current();
    }, 4000);
    return () => clearInterval(timer);
  }, [path, selectedId]);
  const run = detail.data?.pipeline;
  const jobs = detail.data?.jobs || [];
  const computers = [...new Set(jobs.map((job: any) => job.computer).filter(Boolean))].join(', ');
  async function start() {
    setBusy(true);
    setError('');
    try {
      const result = await request<any>(path, {
        method: 'POST',
        body: JSON.stringify({
          operationId: crypto.randomUUID(),
          ...(run ? { ref: run.commit, ...(run.pullId ? { pullId: run.pullId } : {}) } : {}),
        }),
      });
      setSelected(result.id);
      runs.refresh();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {(error || runs.error || detail.error) && (
        <Banner kind="danger" title={error || runs.error || detail.error} />
      )}
      {!runs.data && !runs.error && <Skeleton rows={4} />}
      <div className="v2-pipelines">
        <nav className="v2-pipeline-list" aria-label="Pipeline runs">
          {runs.data?.runs.map((entry: any) => (
            <button
              type="button"
              key={entry.id}
              className={`dl-nav ${selectedId === entry.id ? 'on' : ''}`}
              aria-current={selectedId === entry.id ? 'true' : undefined}
              onClick={() => setSelected(entry.id)}
            >
              <Icon
                name={
                  entry.status === 'succeeded'
                    ? 'check'
                    : entry.status === 'failed'
                      ? 'close'
                      : 'running'
                }
                className={
                  entry.status === 'succeeded'
                    ? 'dl-ok'
                    : entry.status === 'failed'
                      ? 'dl-fail'
                      : 'dl-run'
                }
              />
              <span className="dl-t">
                <span className="dl-strong dl-mono">{entry.commit.slice(0, 7)}</span>
                <span className="dl-meta">
                  {entry.id === runs.data.runs[0].id && entry.trigger === 'push'
                    ? `Push to ${entry.branch || 'main'}`
                    : formatTime(entry.createdAt)}
                  {entry.status === 'failed'
                    ? ` · ${entry.jobsStatus === 'succeeded' ? 'publish failed' : 'tests failed · nothing published'}`
                    : ` · ${elapsed(entry.createdAt, entry.packages?.completedAt || entry.completedAt) || entry.status}`}
                </span>
              </span>
            </button>
          ))}
        </nav>
        <div className="v2-pipeline-detail">
          <div className="dl-page-head">
            <div className="dl-t">
              {run && (
                <>
                  <span className="dl-strong">{run.title || run.commit.slice(0, 7)}</span>
                  <span className="dl-meta">
                    {run.commit.slice(0, 7)}
                    {run.mergedPull
                      ? ` · #${run.mergedPull.number} merged by ${run.mergedPull.mergedByYou ? 'you' : run.mergedPull.mergedBy || 'the owner'}`
                      : ''}
                    {computers ? ` · ran on ${computers}` : ''}
                  </span>
                </>
              )}
            </div>
            <span className="dl-end">
              <Action variant="secondary" disabled={busy} onClick={() => void start()}>
                Run pipeline
              </Action>
            </span>
          </div>
          {run?.packages?.error && <Banner kind="danger" title={run.packages.error} />}
          {run?.deployment?.error && <Banner kind="danger" title={run.deployment.error} />}
          {run && (
            <section className="dl-section">
              <h2 className="dl-section-title">Jobs</h2>
              <Group>
                <div className="dl-inset">
                  {jobs
                    .filter((job: any) => !job.packagePublish)
                    .map((job: any) => (
                      <Setting
                        key={job.id}
                        label={job.name}
                        description={<span className="dl-mono">{job.command}</span>}
                      >
                        <span className="dl-v">
                          {job.status === 'succeeded'
                            ? 'Passed'
                            : job.status === 'failed'
                              ? 'Failed'
                              : job.waitingReason || job.status}
                          {elapsed(job.startedAt, job.finishedAt)
                            ? ` · ${elapsed(job.startedAt, job.finishedAt)}`
                            : ''}
                        </span>
                        <Action variant="quiet" onClick={() => setLog(job)}>
                          Log
                        </Action>
                      </Setting>
                    ))}
                </div>
              </Group>
            </section>
          )}
          {!!run?.packages?.items?.length && (
            <section className="dl-section">
              <h2 className="dl-section-title">Packages</h2>
              <Group>
                {run.packages.items.map((item: any) => (
                  <Item
                    key={item.path}
                    lead={<Icon name="package" />}
                    title={
                      <span className="dl-mono">
                        {item.name || item.path}
                        {item.version ? ' ' + item.version : ''}
                      </span>
                    }
                    description={
                      item.status === 'published'
                        ? `Published${item.previousVersion ? ' · was ' + item.previousVersion : ''}`
                        : item.status === 'skipped'
                          ? `Skipped · ${item.reason}`
                          : item.status === 'checked'
                            ? 'Passed'
                            : item.reason || item.status
                    }
                    href={
                      ['published', 'skipped'].includes(item.status) && item.name
                        ? '/dashboard/packages/npm/' + encodeURIComponent(item.name)
                        : undefined
                    }
                    end={
                      item.jobId && !['published', 'skipped'].includes(item.status) ? (
                        <Action
                          variant="quiet"
                          onClick={() => setLog(jobs.find((job: any) => job.id === item.jobId))}
                        >
                          Log
                        </Action>
                      ) : undefined
                    }
                  />
                ))}
              </Group>
            </section>
          )}
        </div>
      </div>
      <Dialog open={!!log} title={log?.name || 'Log'} onClose={() => setLog(undefined)}>
        <Term>{log?.output || log?.error || ''}</Term>
      </Dialog>
    </>
  );
}
