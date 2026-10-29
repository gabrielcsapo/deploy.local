'use client';
import { useEffect, useState } from 'react';
import {
  Action,
  Banner,
  Composer,
  Empty,
  Field,
  Glyph,
  Icon,
  Item,
  Seg,
  Skeleton,
} from '@/components/ui';
import type {
  AgentConfiguration as Agent,
  AgentTracking,
  ConversationEvent,
} from '../../../../../shared/v2/contracts';
import { useInbox } from '../data/hooks';
import { ConversationItem } from '../conversation/Conversation';
import { formatTime } from '../data/time';
import { request } from './shared';

export function AgentConversation({ agent }: { agent: Agent }) {
  const [tracking, setTracking] = useState<AgentTracking | null>(null);
  const [events, setEvents] = useState<ConversationEvent[] | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('everything');
  const [composerKey, setComposerKey] = useState(0);
  const inbox = useInbox();
  const [starting, setStarting] = useState(false);
  const path = `/agents/${encodeURIComponent(agent.id)}/conversation`;
  async function runNow() {
    setStarting(true);
    setError('');
    try {
      const { task } = await request(`/agents/${encodeURIComponent(agent.id)}/run`, 'POST');
      window.location.assign(`/dashboard/tasks/${encodeURIComponent(task.id)}`);
    } catch (failure: any) {
      setError(failure.message);
      setStarting(false);
    }
  }
  const schedule = agent.schedule?.enabled
    ? `Every morning at ${agent.schedule.time}`
    : 'Only when you press Run now';
  const lastStart = tracking?.schedule
    ? {
        started: 'Started its task',
        asked: 'Asked you first, in Waiting on you',
        paused: 'Skipped while paused',
        never: 'Skipped: Start a task is set to Never',
        failed: `Could not start: ${tracking.schedule.error || 'unknown error'}`,
      }[tracking.schedule.result || ''] || 'Waiting for the next scheduled time'
    : undefined;
  useEffect(() => {
    let active = true;
    const refresh = () =>
      request(path)
        .then((body) => {
          if (active) {
            setEvents(body.events);
            setTracking(body.tracking || null);
            setError('');
          }
        })
        .catch((failure) => {
          if (active) setError(failure.message);
        });
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [path]);
  async function send(text: string) {
    setPending(true);
    setError('');
    try {
      setEvents((await request(path, 'POST', { text })).events);
      setComposerKey((value) => value + 1);
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setPending(false);
    }
  }
  const waiting = inbox.items.filter((item) => item.from === agent.id && item.state === 'waiting');
  const visible = (events || []).filter(
    (event) =>
      event.kind === 'decision' ||
      ((filter !== 'tasks' || event.kind === 'task') &&
        filter !== 'decisions' &&
        (!query || JSON.stringify(event).toLowerCase().includes(query.toLowerCase()))),
  );
  const groups = Map.groupBy(visible, (event) => formatTime(event.at, 'day'));
  const latestDay = [...groups.keys()].at(-1);
  return (
    <div className="dl-agent-chat-layout">
      <div className="dl-agent-chat-main">
        <div className="dl-scroll">
          <div className="dl-agent-chat">
            {error && <Banner kind="danger" title={error} />}
            {events && new Set(events.map((event) => event.at.slice(0, 10))).size > 1 && (
              <div className="dl-agent-search">
                <Field
                  label="Search this conversation"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
                <Seg
                  label="Conversation filter"
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { label: 'Everything', value: 'everything' },
                    { label: 'Decisions', value: 'decisions' },
                    { label: 'Tasks', value: 'tasks' },
                  ]}
                />
              </div>
            )}
            {!events && !error && <Skeleton rows={4} label="Loading conversation" />}
            {events?.length === 0 && (
              <Empty title={`Ask ${agent.name}`}>Replies and decisions will appear here.</Empty>
            )}
            {[...groups].map(([day, items]) =>
              day === latestDay ||
              query ||
              filter !== 'everything' ||
              items.some(
                (event) =>
                  event.kind === 'decision' &&
                  waiting.some((item) => item.id === event.inboxItemId),
              ) ? (
                <section key={day} className="dl-agent-day">
                  <p className="dl-meta">{day}</p>
                  {items.map((event) => (
                    <div key={event.id}>
                      {event.kind === 'decision' && (
                        <div className="dl-agent-decision-author">
                          <Glyph
                            kind={
                              agent.id === 'warden' ? 'warden' : agent.id === 'scout' ? '' : 'plain'
                            }
                          >
                            {agent.name[0]}
                          </Glyph>
                          <span>{agent.name}</span>
                          <span className="dl-meta">{formatTime(event.at)}</span>
                        </div>
                      )}
                      <ConversationItem event={event} resources={{ tasks: tracking?.running }} />
                    </div>
                  ))}
                </section>
              ) : (
                <details key={day} className="dl-group dl-agent-history">
                  <summary>
                    {day} · {items.length} updates
                  </summary>
                  <div className="dl-agent-day">
                    {items.map((event) => (
                      <div key={event.id}>
                        {event.kind === 'decision' && (
                          <div className="dl-agent-decision-author">
                            <Glyph
                              kind={
                                agent.id === 'warden'
                                  ? 'warden'
                                  : agent.id === 'scout'
                                    ? ''
                                    : 'plain'
                              }
                            >
                              {agent.name[0]}
                            </Glyph>
                            <span>{agent.name}</span>
                            <span className="dl-meta">{formatTime(event.at)}</span>
                          </div>
                        )}
                        <ConversationItem event={event} resources={{ tasks: tracking?.running }} />
                      </div>
                    ))}
                  </div>
                </details>
              ),
            )}
          </div>
        </div>
        <div className="dl-agent-composer">
          <Composer
            key={composerKey}
            project={agent.name}
            computer={agent.computers.join(', ') || 'All computers'}
            model="Connected model"
            loading={pending}
            onSend={(text) => void send(text)}
          />
        </div>
      </div>
      <aside className="dl-agent-tracking">
        <h2 className="dl-section-title">Tracking</h2>
        <section>
          <h3 className="dl-meta">Background runs</h3>
          <Item
            lead={<Icon name="clock" />}
            title={schedule}
            description={
              tracking?.schedule
                ? `Last scheduled ${formatTime(`${tracking.schedule.day}T12:00:00`, 'day')} · ${lastStart}`
                : 'Each run is a task: its own folder, questions in Waiting on you, and a report.'
            }
          />
          {tracking?.runs
            ?.filter((run) => !tracking.running.some((task) => task.id === run.id))
            .slice(0, 5)
            .map((run) => (
              <Item
                key={run.id}
                lead={<Icon name={run.status === 'failed' ? 'attention' : 'check'} />}
                title={run.title}
                description={`${run.status} · ${formatTime(run.at)}`}
                href={`/dashboard/tasks/${encodeURIComponent(run.id)}`}
              />
            ))}
          <Action loading={starting} onClick={() => void runNow()}>
            Run now
          </Action>
        </section>
        <a className="dl-item" href="/dashboard/inbox">
          <span className="dl-t">
            <span>
              {waiting.length} of {agent.name}’s questions
            </span>
            <span>In Waiting on you</span>
          </span>
        </a>
        <section>
          <h3 className="dl-meta">Running</h3>
          {tracking?.running.map((task) => (
            <Item
              key={task.id}
              lead={<Icon name="running" className="dl-spin" />}
              title={task.title}
              description={[task.computer, formatTime(task.at, 'elapsed')]
                .filter(Boolean)
                .join(' · ')}
              href={`/dashboard/tasks/${encodeURIComponent(task.id)}`}
            />
          ))}
          {!tracking?.running.length && (
            <p className="dl-meta">{tracking ? 'No running tasks' : 'Unavailable'}</p>
          )}
        </section>
        <section>
          <h3 className="dl-meta">Watching</h3>
          {tracking?.watching.map((issue) => (
            <Item
              key={issue.id}
              lead={<Icon name="file" />}
              title={issue.title}
              href={
                issue.projectId
                  ? `/dashboard/projects/${encodeURIComponent(issue.projectId)}/issues`
                  : undefined
              }
            />
          ))}
          {!tracking?.watching.length && (
            <p className="dl-meta">{tracking ? 'No watched issues' : 'Unavailable'}</p>
          )}
        </section>
        <section>
          <h3 className="dl-meta">Shipped this week</h3>
          <Item
            lead={<Icon name="merge" />}
            title={tracking ? `${tracking.shipped.length} pull requests` : 'Unavailable'}
            description={
              tracking?.shipped[0]
                ? `Last: ${[...tracking.shipped].sort((a, b) => b.at.localeCompare(a.at))[0].title}`
                : undefined
            }
          />
        </section>
        <a className="dl-link" href={`/dashboard/agents/${encodeURIComponent(agent.id)}/tune`}>
          Tune {agent.name}
        </a>
      </aside>
    </div>
  );
}
