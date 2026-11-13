'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, Composer, Icon, Skeleton } from '@/components/ui';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import type {
  AgentConfiguration as Agent,
  AgentTracking,
  ConversationEvent,
  LooksAfterItem,
} from '../../../../../shared/v2/contracts';
import { agentSuggestions, itemSummary, itemWhen, weekDays } from '../../../../../shared/v2/agents';
import { ConversationItem } from '../conversation/Conversation';
import { useProjectFormatting } from '../projects/formatting';
import { useDataSeed, readSeeded } from '../data/seeds';
import { LooksAfterEditor, itemHistoryPath } from './item';
import { request } from './shared';
import { useResource } from '../data/hooks';
export function AgentConversation({
  agent,
  onChanged,
}: {
  agent: Agent;
  onChanged: (agent: Agent) => void;
}) {
  const seed = useDataSeed();
  const { formatTime } = useProjectFormatting();
  const snapshot = seed?.data[`/api/v2/agents/${encodeURIComponent(agent.id)}/conversation`] as
    | { events: ConversationEvent[]; tracking: AgentTracking }
    | undefined;
  const projects =
    useResource<{ projects: import('../../../../../shared/v2/contracts').Project[] }>(
      '/api/v2/projects',
    ).data?.projects ?? [];
  const [tracking, setTracking] = useState<AgentTracking | null>(snapshot?.tracking ?? null);
  const [events, setEvents] = useState<ConversationEvent[] | null>(snapshot?.events ?? null);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<LooksAfterItem | null>(null);
  const [suggestion, setSuggestion] = useState<{ text: string; nonce: number }>();
  const [busy, setBusy] = useState(false);
  const path = `/agents/${encodeURIComponent(agent.id)}`;
  useEffect(() => {
    let active = true;
    const refresh = (initial: boolean | Event = false) =>
      (initial === true
        ? readSeeded(seed, `/api/v2${path}/conversation`, () => request(`${path}/conversation`))
        : request(`${path}/conversation`)
      )
        .then((body) => {
          if (active) {
            setEvents(body.events);
            setTracking(body.tracking);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void refresh(true);
    window.addEventListener('deploy:agents-changed', refresh);
    window.addEventListener('deploy:conversation-changed', refresh);
    return () => {
      active = false;
      window.removeEventListener('deploy:agents-changed', refresh);
      window.removeEventListener('deploy:conversation-changed', refresh);
    };
  }, [path, seed]);
  async function confirm(item: LooksAfterItem) {
    setBusy(true);
    setError('');
    try {
      onChanged(
        (await request(`${path}/items/${encodeURIComponent(item.id)}/confirm`, 'POST')).agent,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const groups = Map.groupBy(events ?? [], (e) => formatTime(e.at, 'day'));
  function render(event: ConversationEvent) {
    const task =
      event.kind === 'task'
        ? tracking?.running.find((entry) => entry.id === event.taskId)
        : undefined;
    return (
      <div key={event.id} className="dl-agent-event">
        {event.kind === 'reply' &&
          !events
            ?.slice(0, events.indexOf(event))
            .some(
              (entry) =>
                entry.kind === 'reply' &&
                entry.agent === event.agent &&
                formatTime(entry.at, 'day') === formatTime(event.at, 'day'),
            ) && (
            <div className="dl-agent-decision-author">
              <AgentAvatar id={agent.id} avatar={agent.avatar} />
              <span>{agent.name}</span>
            </div>
          )}
        {event.kind === 'task' ? (
          <a
            className="dl-item dl-agent-task"
            href={`/dashboard/tasks/${encodeURIComponent(event.taskId)}`}
          >
            <AgentAvatar id={agent.id} avatar={agent.avatar} />
            <span className="dl-t">
              <span>
                {task?.title ??
                  tracking?.runs?.find((entry) => entry.id === event.taskId)?.title ??
                  event.taskId}
              </span>
              <span>
                Task ·{' '}
                {task?.computer ? `Running on ${task.computer}` : task ? 'Running' : 'Started'} ·{' '}
                {formatTime(event.at).toLowerCase()}
              </span>
            </span>
            <Icon name="chevron" />
          </a>
        ) : (
          <ConversationItem event={event} resources={{ tasks: tracking?.running }} />
        )}
        {event.kind === 'reply' &&
          event.receipts?.map((receipt, i) =>
            receipt.kind !== 'looks-after'
              ? null
              : (() => {
                  const item = agent.looksAfter?.find((v) => v.id === receipt.itemId);
                  return item ? (
                    <div className="dl-agent-receipt" key={i}>
                      {item.confirmedAt
                        ? `Confirmed · first check ${item.when.every === 'week' ? `${weekDays[item.when.day ?? 1]} ${item.when.time}` : itemWhen(item)}`
                        : `Now looks after: ${item.what.split('\n')[0]} · ${itemSummary(item, projects)}`}{' '}
                      ·{' '}
                      {!item.confirmedAt && (
                        <>
                          <Action
                            variant="primary"
                            disabled={busy}
                            onClick={() => void confirm(item)}
                          >
                            Confirm
                          </Action>{' '}
                          ·{' '}
                        </>
                      )}
                      <button type="button" className="dl-link" onClick={() => setEdit(item)}>
                        Edit
                      </button>
                    </div>
                  ) : null;
                })(),
          )}
      </div>
    );
  }
  return (
    <div className="dl-agent-chat-layout">
      <div className="dl-agent-chat-main">
        <div className="dl-scroll">
          <div className="dl-agent-chat">
            {agent.looksAfter
              ?.filter((item) => item.confirmedAt)
              .map((item) => (
                <p className="dl-meta" key={item.id}>
                  Looks after: {item.what.split('\n')[0]} · {itemWhen(item)} ·{' '}
                  <a className="dl-link" href={itemHistoryPath(agent.id, item.id)}>
                    History
                  </a>
                </p>
              ))}
            {error && <Banner kind="danger" title={error} />}{' '}
            {!events && !error && <Skeleton rows={4} />}{' '}
            {events?.length === 0 && (
              <div className="dl-agent-hello">
                <AgentAvatar id={agent.id} avatar={agent.avatar} size={88} />
                <h1 className="dl-title">{agent.name}</h1>
                <p>Tell {agent.name} what you want it to do. It remembers.</p>
                <div className="dl-agent-suggestions">
                  {agentSuggestions.map((text) => (
                    <Action key={text} onClick={() => setSuggestion({ text, nonce: Date.now() })}>
                      {text}
                    </Action>
                  ))}
                </div>
              </div>
            )}
            {[...groups].map(([day, items], index) =>
              index === groups.size - 1 ? (
                <section className="dl-agent-day" key={day}>
                  {items.map(render)}
                </section>
              ) : (
                <details key={day} className="dl-agent-history">
                  <summary>
                    {day} · {items.length} updates
                  </summary>
                  <div className="dl-agent-day">{items.map(render)}</div>
                </details>
              ),
            )}
          </div>
        </div>
        <div className="dl-agent-composer">
          <Composer
            project={null}
            computer={tracking?.running.find((task) => task.computer)?.computer ?? null}
            suggestedText={suggestion}
          />
        </div>
      </div>
      {edit && (
        <LooksAfterEditor
          agent={agent}
          item={edit}
          onSaved={onChanged}
          onClose={() => setEdit(null)}
        />
      )}
    </div>
  );
}
