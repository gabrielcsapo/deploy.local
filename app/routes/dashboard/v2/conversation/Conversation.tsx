'use client';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SavedAgentAvatar } from '../agents/identity';
import { Glyph, Icon, WorkLog } from '@/components/ui';
import type { ConversationEvent, Release, Screenshot } from '../../../../../shared/v2/contracts';
import { InboxDecision } from '../inbox/InboxDecision';
import { useAgentName } from '../data/hooks';
import { useProjectFormatting } from '../projects/formatting';
import { conversationDays, safeResourceUrl, workLogs } from './model';
import { AttachmentImage, ScreenshotEvent } from './Media';
import './style.css';

export type ConversationResources = {
  showAuthors?: boolean;
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
          {event.attachments.map((attachment, i) => (
            <a className="dl-chat-attachment" key={i} href={safeResourceUrl(attachment.ref)}>
              {['photo', 'screenshot'].includes(attachment.kind) && (
                <AttachmentImage src={attachment.ref} alt={attachment.name} />
              )}
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
          <Markdown remarkPlugins={[remarkGfm]}>{event.paragraphs.join('\n\n')}</Markdown>
        </div>
      );
    case 'worklog': {
      const steps = event.steps.map((step) => ({
        ...step,
        live: step.live ?? event.live,
        icon:
          step.glyph === 'deploy'
            ? ('deploy' as const)
            : step.icon === 'edit'
              ? ('compose' as const)
              : step.icon === 'logs'
                ? ('terminal' as const)
                : step.icon,
      }));
      return (
        <WorkLog
          summary={event.summary}
          live={event.live}
          steps={steps}
          defaultOpen={steps.some((step) => step.live || step.tone === 'fail')}
        />
      );
    }
    case 'decision':
      return <InboxDecision itemId={event.inboxItemId} />;
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
