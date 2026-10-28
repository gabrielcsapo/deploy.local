'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, Icon, Status } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { authenticatedFetch, request } from './data';
import { projectSegment } from './routing';
export function ProjectLogs({ project, selected }: { project: Project; selected: string }) {
  const [lines, setLines] = useState<{ app: string; text: string }[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState('');
  const [live, setLive] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    setError('');
    setLive(false);
    async function start() {
      try {
        const { sources } = await request<{ sources: { app: string; url: string }[] }>(
          `/api/v2/projects/${projectSegment(project.id)}/logs?app=${encodeURIComponent(selected)}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        await Promise.all(
          sources.map(async (source) => {
            const response = await authenticatedFetch(source.url, { signal: controller.signal });
            if (!response.ok || !response.body)
              throw new Error(`${source.app}: logs are unavailable`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            setLive(true);
            const append = (text: string[]) => {
              if (!controller.signal.aborted)
                setLines((old) =>
                  [...old, ...text.map((text) => ({ app: source.app, text }))].slice(-3000),
                );
            };
            try {
              for (;;) {
                const { value, done } = await reader.read();
                pending += decoder.decode(value, { stream: !done });
                const chunks = pending.split('\n');
                pending = chunks.pop() || '';
                append(chunks);
                if (done) {
                  if (pending) append([pending]);
                  break;
                }
              }
            } finally {
              reader.releaseLock();
            }
          }),
        );
        if (!controller.signal.aborted) setLive(false);
      } catch (error) {
        if (!controller.signal.aborted) {
          setError((error as Error).message);
          setLive(false);
          controller.abort();
        }
      }
    }
    void start();
    return () => controller.abort();
  }, [project.id, selected, retry]);
  return (
    <>
      <div className="v2-project-toolbar v2-log-toolbar">
        <div className="dl-field v2-log-search">
          <Icon name="search" />
          <input
            aria-label="Filter logs"
            placeholder="Filter logs"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </div>
        <label>
          <span className="dl-sr">App</span>
          <select
            className="dl-matrix-select"
            value={selected}
            onChange={(event) => {
              const url = new URL(window.location.href);
              if (event.target.value) url.searchParams.set('app', event.target.value);
              else url.searchParams.delete('app');
              window.location.assign(url);
            }}
          >
            <option value="">All apps</option>
            {project.apps.map((app) => (
              <option key={app.id} value={app.name}>
                {app.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="dl-sr">Level</span>
          <select
            className="dl-matrix-select"
            value={level}
            onChange={(event) => setLevel(event.target.value)}
          >
            <option value="">Any level</option>
            <option>info</option>
            <option>warn</option>
            <option>error</option>
          </select>
        </label>
        <Status kind={live ? 'active' : 'inactive'}>{live ? 'Live' : 'Paused'}</Status>
      </div>
      {error && (
        <Banner
          title={error}
          action={<Action onClick={() => setRetry((n) => n + 1)}>Reconnect</Action>}
        />
      )}
      <pre className="v2-project-logs" aria-label="Project logs">
        {lines
          .filter(
            (line) =>
              `${line.app} ${line.text}`.toLowerCase().includes(filter.toLowerCase()) &&
              (!level || new RegExp(`\\b${level}\\b`, 'i').test(line.text)),
          )
          .map((line, index) => (
            <div
              key={index}
              className={/\b(error|fatal)\b/i.test(line.text) ? 'v2-log-error' : undefined}
            >
              {!selected && project.apps.length > 1 && (
                <span className="dl-muted">{line.app.padEnd(20)} </span>
              )}
              {line.text}
            </div>
          ))}
        {!lines.length && (live ? 'Waiting for logs…' : 'No log lines received.')}
      </pre>
    </>
  );
}
