'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, ChipSelect, Icon, Status } from '@/components/ui';
import type { Project } from '../../../../../shared/v2/contracts';
import { useDataSeed, freshSeed } from '../data/seeds';
import { remembered } from '../data/hooks';
import { authenticatedFetch, request } from './data';
import { projectSegment } from './routing';
import { logStreamStatus, type LogStreamState } from './logs';

const connecting: LogStreamState = { openStreams: 0, hasOpened: false, finished: false };

export function ProjectLogs({ project, selected }: { project: Project; selected: string }) {
  const seed = useDataSeed();
  const sourcePath = `/api/projects/${projectSegment(project.id)}/logs?app=${encodeURIComponent(selected)}`;
  const [lines, setLines] = useState<{ app: string; text: string }[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [level, setLevel] = useState('');
  const [stream, setStream] = useState(connecting);
  const [retry, setRetry] = useState(0);
  const status = logStreamStatus(stream, Boolean(error));
  const reconnect = () => {
    setError('');
    setStream(connecting);
    setRetry((n) => n + 1);
  };
  useEffect(() => {
    const controller = new AbortController();
    setLines([]);
    setError('');
    setStream(connecting);
    async function start() {
      try {
        const { sources } =
          (retry === 0 && freshSeed(seed, sourcePath)
            ? remembered<{ sources: { app: string; url: string }[] }>(sourcePath, seed)
            : undefined) ??
          (await request<{ sources: { app: string; url: string }[] }>(sourcePath, {
            signal: controller.signal,
          }));
        if (controller.signal.aborted) return;
        await Promise.all(
          sources.map(async (source) => {
            const response = await authenticatedFetch(source.url, { signal: controller.signal });
            if (controller.signal.aborted) return;
            if (!response.ok || !response.body)
              throw new Error(`${source.app}: logs are unavailable`);
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let pending = '';
            setStream((state) => ({
              ...state,
              openStreams: state.openStreams + 1,
              hasOpened: true,
            }));
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
              if (!controller.signal.aborted)
                setStream((state) => ({ ...state, openStreams: state.openStreams - 1 }));
            }
          }),
        );
        if (!controller.signal.aborted) setStream((state) => ({ ...state, finished: true }));
      } catch (error) {
        if (!controller.signal.aborted) {
          setError((error as Error).message);
          setStream((state) => ({ ...state, openStreams: 0, finished: true }));
          controller.abort();
        }
      }
    }
    void start();
    return () => controller.abort();
  }, [project.id, selected, retry, seed, sourcePath]);
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
          <ChipSelect
            label="App"
            value={selected}
            onChange={(value) => {
              const url = new URL(window.location.href);
              if (value) url.searchParams.set('app', value);
              else url.searchParams.delete('app');
              window.location.assign(url);
            }}
            options={[
              { value: '', label: 'All apps' },
              ...project.apps.map((app) => ({ value: app.name, label: app.name })),
            ]}
          />
        </label>
        <label>
          <span className="dl-sr">Level</span>
          <ChipSelect
            label="Level"
            value={level}
            onChange={setLevel}
            options={[
              { value: '', label: 'Any level' },
              ...['info', 'warn', 'error'].map((value) => ({ value, label: value })),
            ]}
          />
        </label>
        <Status kind={status.kind}>{status.label}</Status>
        {status.reconnect && (
          <Action variant="quiet" onClick={reconnect}>
            Reconnect
          </Action>
        )}
      </div>
      {error && <Banner title={error} action={<Action onClick={reconnect}>Retry</Action>} />}
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
        {!lines.length &&
          (status.label === 'Live' ? 'Waiting for logs…' : 'No log lines received.')}
      </pre>
    </>
  );
}
