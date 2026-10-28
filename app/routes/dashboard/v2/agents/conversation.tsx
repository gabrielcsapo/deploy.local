'use client';
import { useEffect, useState } from 'react';
import { Banner, Composer, Empty, Field, Group, Seg, Skeleton, WorkLog } from '@/components/ui';
import type { Agent, ConversationEvent } from '../../../../../shared/v2/contracts';
import { useInbox } from '../data/hooks';
import { InboxDecision } from '../inbox/InboxDecision';
import { request } from './shared';

/** Local typed-event adapter; replace with the task slice's shared conversation renderer on merge. */
function EventView({ event }: { event: ConversationEvent }) {
  switch (event.kind) {
    case 'you':
      return <div className="dl-agent-you">{event.text}</div>;
    case 'reply':
      return (
        <div className="dl-agent-reply">
          {event.paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      );
    case 'decision':
      return <InboxDecision itemId={event.inboxItemId} />;
    case 'worklog':
      return (
        <WorkLog
          summary={event.summary}
          defaultOpen
          live={event.live}
          steps={event.steps.map((step) => ({
            ...step,
            icon: step.icon === 'edit' || step.icon === 'logs' ? 'file' : step.icon,
          }))}
        />
      );
    case 'task':
      return (
        <a
          className="dl-item dl-group"
          href={`/dashboard/tasks/${encodeURIComponent(event.taskId)}`}
        >
          Started a task · {event.taskId}
        </a>
      );
    case 'release':
      return <p className="dl-meta">Release {event.releaseId}</p>;
    case 'screenshot':
      return <p className="dl-meta">Screenshot {event.screenshotId} · open the task to view</p>;
    case 'report':
      return (
        <Group title={event.title}>
          {event.sections.map((section, index) => (
            <section className="dl-inset" key={index}>
              <h3 className="dl-section-title">{section.title}</h3>
              <p className="dl-agent-prose">{section.body}</p>
            </section>
          ))}
        </Group>
      );
  }
}
export function AgentConversation({ agent }: { agent: Agent }) {
  const [events, setEvents] = useState<ConversationEvent[] | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('everything');
  const [composerKey, setComposerKey] = useState(0);
  const inbox = useInbox();
  const path = `/agents/${encodeURIComponent(agent.id)}/conversation`;
  useEffect(() => {
    let active = true;
    const refresh = () =>
      request(path)
        .then((body) => {
          if (active) {
            setEvents(body.events);
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
  const groups = Map.groupBy(visible, (event) => new Date(event.at).toLocaleDateString());
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
                    <EventView key={event.id} event={event} />
                  ))}
                </section>
              ) : (
                <details key={day} className="dl-group dl-agent-history">
                  <summary>
                    {day} · {items.length} updates
                  </summary>
                  <div className="dl-agent-day">
                    {items.map((event) => (
                      <EventView key={event.id} event={event} />
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
        <a className="dl-item" href="/dashboard/inbox">
          <span className="dl-t">
            <span>
              {waiting.length} of {agent.name}’s questions
            </span>
            <span>In Waiting on you</span>
          </span>
        </a>
        <h3 className="dl-meta">Computers</h3>
        <p>{agent.computers.join(', ') || 'All computers'}</p>
        <a className="dl-link" href={`/dashboard/agents/${encodeURIComponent(agent.id)}/tune`}>
          Tune {agent.name}
        </a>
      </aside>
    </div>
  );
}
