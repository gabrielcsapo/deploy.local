'use client';
import { useEffect, useState } from 'react';
import { SavedAgentAvatar } from '../agents/identity';
import { Glyph, Icon, WorkLog } from '@/components/ui';
import type {
  ConversationEvent,
  Release,
  Screenshot,
  StepDetail,
} from '../../../../../shared/v2/contracts';
import { InboxDecision } from '../inbox/InboxDecision';
import { authenticatedFetch, useAgentName } from '../data/hooks';
import { useProjectFormatting } from '../projects/formatting';
import { conversationDays, safeResourceUrl, took, workLogs } from './model';
import { MarkdownWithMedia, MediaRow, ScreenshotEvent } from './Media';
import './style.css';

/** "Working for 3m" that keeps counting while a step runs, instead of stopping at the last one. */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => new Date().toISOString());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date().toISOString()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <>Working for {took(since, now)}</>;
}

const isPicture = (kind: string) => ['photo', 'screenshot', 'video'].includes(kind);

/** A step's detail, loaded once per step however often the page renders; a failure tries again. */
const stepDetails = new Map<string, Promise<StepDetail>>();
function loadStep(id: string): Promise<StepDetail> {
  const cached = stepDetails.get(id);
  if (cached) return cached;
  const [, run, ...item] = id.split(':');
  const loading = authenticatedFetch(
    `/api/runs/${encodeURIComponent(run)}/steps/${encodeURIComponent(item.join(':'))}`,
  )
    .then(async (response) => {
      if (!response.ok) throw new Error(`Step detail ${response.status}`);
      return ((await response.json()) as { detail: StepDetail }).detail;
    })
    .catch((error) => {
      stepDetails.delete(id);
      throw error;
    });
  stepDetails.set(id, loading);
  return loading;
}

export type ConversationResources = {
  showAuthors?: boolean;
  /** In a task: a waiting question is answered from the composer below. */
  inTask?: boolean;
  tasks?: { id: string; title: string }[];
  releases?: Release[];
  screenshots?: Screenshot[];
};
export function ReleaseProgress({ release }: { release: Release }) {
  return (
    <section
      className="dl-release-progress"
      aria-label={`Release ${release.id}`}
      aria-live="polite"
    >
      <a
        href={`/dashboard/projects/${encodeURIComponent(release.projectId)}/releases/${encodeURIComponent(release.id)}`}
      >
        Release {release.id} · {release.state === 'live' ? 'Live' : release.state}
      </a>
      <ul className="dl-steps">
        {release.steps.map((step) => (
          <li className="dl-step" key={step.name}>
            <Icon
              name={
                step.state === 'running' ? 'running' : step.state === 'done' ? 'check' : 'clock'
              }
            />
            <span className="dl-t">
              {step.name[0].toUpperCase() + step.name.slice(1)}
              {step.detail && ` · ${step.detail}`}
            </span>
            <span className="dl-x">{step.state}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
export function ConversationItem({
  event,
  resources = {},
}: {
  event: ConversationEvent;
  resources?: ConversationResources;
}) {
  const agentName = useAgentName();
  const { formatTime } = useProjectFormatting();
  switch (event.kind) {
    case 'you':
      return (
        <div className="dl-you">
          {event.text}
          {event.attachments.some((attachment) => isPicture(attachment.kind)) && (
            <MediaRow
              items={event.attachments
                .filter((attachment) => isPicture(attachment.kind))
                .map((attachment) => ({ src: attachment.ref, alt: attachment.name }))}
            />
          )}
          {event.attachments
            .filter((attachment) => !isPicture(attachment.kind))
            .map((attachment, i) => (
              <a className="dl-chat-attachment" key={i} href={safeResourceUrl(attachment.ref)}>
                {attachment.name}
              </a>
            ))}
        </div>
      );
    case 'reply':
      return (
        <div className="dl-reply" aria-label={`${agentName(event.agent)} replied`}>
          {resources.showAuthors && (
            <div className="dl-chat-author">
              <SavedAgentAvatar id={event.agent} />
              {agentName(event.agent)} <span className="dl-meta">· {formatTime(event.at)}</span>
            </div>
          )}
          <MarkdownWithMedia text={event.paragraphs.join('\n\n')} />
        </div>
      );
    case 'worklog': {
      const steps = event.steps.map((step) => ({
        ...step,
        live: step.live ?? event.live,
        ...(step.opens && step.id?.startsWith('work:')
          ? { load: () => loadStep(step.id as string) }
          : {}),
        note: step.glyph === 'note',
        icon:
          step.glyph === 'deploy'
            ? ('deploy' as const)
            : step.glyph === 'note'
              ? ('comment' as const)
              : step.icon === 'edit'
                ? ('compose' as const)
                : step.icon === 'logs'
                  ? ('terminal' as const)
                  : step.icon,
      }));
      return (
        <WorkLog
          summary={
            event.live && event.summary.startsWith('Working for') ? (
              <Elapsed since={event.at} />
            ) : (
              event.summary
            )
          }
          live={event.live}
          steps={steps}
          defaultOpen={steps.some((step) => step.live || step.tone === 'fail')}
        />
      );
    }
    case 'decision':
      return <InboxDecision itemId={event.inboxItemId} inTask={resources.inTask} />;
    case 'task':
      return (
        <a className="dl-chat-link" href={`/dashboard/tasks/${encodeURIComponent(event.taskId)}`}>
          <Glyph>
            <Icon name="compose" />
          </Glyph>
          <span>
            Started a task
            <br />
            {resources.tasks?.find((task) => task.id === event.taskId)?.title || event.taskId}
          </span>
          <Icon name="chevron" />
        </a>
      );
    case 'release': {
      const release = resources.releases?.find((item) => item.id === event.releaseId);
      return release ? (
        <ReleaseProgress release={release} />
      ) : (
        <p className="dl-meta">Release {event.releaseId} · details unavailable</p>
      );
    }
    case 'screenshot': {
      const shot = resources.screenshots?.find((item) => item.id === event.screenshotId);
      return <ScreenshotEvent id={event.screenshotId} screenshot={shot} />;
    }
    case 'report':
      return (
        <section className="dl-chat-report">
          <h3>{event.title}</h3>
          {event.sections.map((section, i) => (
            <div key={i}>
              <h4>{section.title}</h4>
              <p>{section.body}</p>
            </div>
          ))}
        </section>
      );
  }
}
function ConversationItems({
  events,
  resources,
}: {
  events: ConversationEvent[];
  resources?: ConversationResources;
}) {
  const groups: ConversationEvent[][] = [];
  for (const event of workLogs(events)) {
    const previous = groups.at(-1);
    if (event.kind === 'screenshot' && previous?.[0].kind === 'screenshot') previous.push(event);
    else groups.push([event]);
  }
  return groups.map((group) =>
    group[0].kind === 'screenshot' ? (
      <div className="dl-shot-gallery" key={group[0].id}>
        {group.map((event) => (
          <ConversationItem key={event.id} event={event} resources={resources} />
        ))}
      </div>
    ) : (
      <ConversationItem key={group[0].id} event={group[0]} resources={resources} />
    ),
  );
}
export function Conversation({
  events,
  resources,
}: {
  events: ConversationEvent[];
  resources?: ConversationResources;
}) {
  const { now, timeZone } = useProjectFormatting();
  const days = conversationDays(events, new Date(now), timeZone);
  return (
    <div className="dl-thread">
      {days.map(({ day, events: items, pinned, folded }) => (
        <div className="dl-chat-day" key={day}>
          {folded ? (
            <>
              <details className="dl-chat-history">
                <summary>
                  {day}
                  <span>
                    {items.length} {items.length === 1 ? 'event' : 'events'}
                  </span>
                </summary>
                <div className="dl-turn">
                  <ConversationItems
                    events={items.filter((event) => event.kind !== 'decision')}
                    resources={resources}
                  />
                </div>
              </details>
              {pinned.map((event) => (
                <ConversationItem key={event.id} event={event} resources={resources} />
              ))}
            </>
          ) : (
            <>
              {days.length > 1 && <div className="dl-chat-today dl-meta">{day}</div>}
              <ConversationItems events={items} resources={resources} />
            </>
          )}
        </div>
      ))}
    </div>
  );
}
