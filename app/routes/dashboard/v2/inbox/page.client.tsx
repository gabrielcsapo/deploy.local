'use client';
import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Empty,
  Group,
  Head,
  Icon,
  IconButton,
  Item,
  Skeleton,
} from '@/components/ui';
import type { DesignReviewSummary, InboxItem } from '../../../../../shared/v2/contracts';
import { SavedAgentAvatar } from '../agents/identity';
import { useAgentName, useInbox, useResource } from '../data/hooks';
import type { WorkspaceState } from '../data/sidebar';
import { useData } from '../projects/data';
import { useProjectFormatting } from '../projects/formatting';
import { inboxItemHref } from '../design/review-model';
import { DesignDetail } from './DesignDetail';
import { answerDetails, answerLabel, InboxDecision, Outcome } from './InboxDecision';
import { RiskCard, WaitingRow } from './WaitingRows';
import { contextLine, openItem, waitingGroups } from './waiting';
import './waiting.css';

function Header() {
  return (
    <Head
      menu={
        <IconButton
          icon="menu"
          label="Show sidebar"
          className="dl-menu-btn"
          onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
        />
      }
      actions={<IconButton icon="search" label="Search (coming soon)" disabled />}
    />
  );
}

export default function Inbox() {
  const [params] = useSearchParams();
  const answered = params.get('tab') === 'answered';
  const selected = params.get('item');
  const inbox = useInbox();
  const agentName = useAgentName();
  const { now } = useProjectFormatting();
  const workspace = useResource<WorkspaceState>('/api/state');
  // A design's project, proposer and screens come with its review summary.
  const version = inbox.items
    .filter((item) => item.state === 'waiting' && item.id.startsWith('design:'))
    .map((item) => item.id)
    .join(',');
  const reviews = useData<{ proposals: DesignReviewSummary[] }>(
    version ? `/api/design/reviews?v=${encodeURIComponent(version)}` : undefined,
  );
  const summaries = useMemo(
    () => new Map((reviews.data?.proposals ?? []).map((proposal) => [proposal.id, proposal])),
    [reviews.data],
  );
  const projectName = (item: InboxItem) =>
    item.projectName ??
    workspace.data?.projects?.find((project) => project.id === item.projectId)?.name ??
    null;
  const who = (item: InboxItem) => item.fromName || agentName(item.from);
  const context = (item: InboxItem) =>
    contextLine(item, {
      project: projectName(item),
      who: who(item),
      review: summaries.get(item.id),
      now: new Date(now),
    });

  // Keep a decision on screen when it is answered here or in another client.
  const [seen, setSeen] = useState<string[]>([]);
  useEffect(() => {
    if (answered) setSeen([]);
    else
      setSeen((previous) => [
        ...new Set([
          ...previous,
          ...inbox.items.filter((item) => item.state === 'waiting').map((item) => item.id),
        ]),
      ]);
  }, [answered, inbox.items]);
  const groups = waitingGroups(
    inbox.items.filter(
      (item) => item.state === 'waiting' || seen.includes(item.id) || item.id === selected,
    ),
  );
  const open = answered ? null : openItem(groups, selected);

  if (answered) return <Answered />;
  return (
    <>
      <Header />
      <div className={`dl-asks${selected && open ? ' v2-open' : ''}`}>
        <div className="dl-asks-list">
          <div className="dl-asks-head">
            <h1 className="dl-display">Waiting on you</h1>
            <a href="/dashboard/inbox?tab=answered">Answered</a>
          </div>
          {inbox.error && (
            <Banner title={inbox.error} action={<Action onClick={inbox.retry}>Retry</Action>} />
          )}
          {inbox.loading ? (
            <Skeleton label="Loading decisions" />
          ) : (
            groups.length === 0 &&
            !inbox.error && (
              <Empty title="Nothing waiting on you">
                When an agent needs a decision, it appears here.
              </Empty>
            )
          )}
          {groups.map((group) => (
            <section className="dl-asks-section" aria-label={group.label} key={group.id}>
              <h2 className="dl-group-label">
                {group.label}
                <span className="dl-n">
                  {group.items.filter((item) => item.state === 'waiting').length}
                </span>
              </h2>
              {group.id === 'decide' ? (
                <div className="v2-asks-cards">
                  {group.items.map((item) => (
                    <RiskCard key={item.id} item={item} context={context(item)} />
                  ))}
                </div>
              ) : (
                <div className="dl-group">
                  {group.items.map((item) => (
                    <WaitingRow
                      key={item.id}
                      item={item}
                      context={context(item)}
                      on={item.id === open?.id}
                    />
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
        {open && (
          <div className="dl-asks-detail">
            {open.id.startsWith('design:') ? (
              <DesignDetail
                key={open.id}
                item={open}
                summary={summaries.get(open.id)}
                project={projectName(open)}
                who={who(open)}
                now={now}
              />
            ) : (
              <div className="dl-asks-detail-scroll">
                <div className="dl-asks-pane">
                  <a className="dl-asks-crumb v2-asks-crumb" href="/dashboard/inbox">
                    <Icon name="back" size={14} />
                    Waiting on you
                  </a>
                  <InboxDecision key={open.id} itemId={open.id} />
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}

/** Every answer, by day, reached from the link beside Waiting on you. */
function Answered() {
  const { formatTime } = useProjectFormatting();
  const agentName = useAgentName();
  const inbox = useInbox();
  const dayLabel = (at: string) => {
    const day = formatTime(at, 'day');
    return day === 'Today' || day === 'Yesterday' ? day : 'Earlier';
  };
  const history = inbox.items
    .filter((item) => item.state === 'answered')
    .sort(
      (a, b) => Date.parse(b.answer?.at || b.createdAt) - Date.parse(a.answer?.at || a.createdAt),
    );
  return (
    <>
      <Header />
      <div className="dl-asks">
        <div className="dl-asks-list v2-asks-answered">
          <a className="dl-asks-crumb" href="/dashboard/inbox">
            <Icon name="back" size={14} />
            Waiting on you
          </a>
          <div className="dl-asks-head">
            <h1 className="dl-display">Answered</h1>
          </div>
          {inbox.error && (
            <Banner title={inbox.error} action={<Action onClick={inbox.retry}>Retry</Action>} />
          )}
          {inbox.loading ? (
            <Skeleton label="Loading decisions" />
          ) : (
            history.length === 0 &&
            !inbox.error && <Empty title="No answers yet">Decisions you answer appear here.</Empty>
          )}
          {['Today', 'Yesterday', 'Earlier'].map((day) => {
            const items = history.filter(
              (item) => dayLabel(item.answer?.at || item.createdAt) === day,
            );
            return (
              items.length > 0 && (
                <section className="dl-asks-section" aria-label={day} key={day}>
                  <h2 className="dl-group-label">
                    {day}
                    <span className="dl-n">{items.length}</span>
                  </h2>
                  <Group>
                    {items.map((item) => (
                      <Item
                        key={item.id}
                        title={item.title}
                        description={`${item.fromName || agentName(item.from)} asked · ${answerDetails(item)}`}
                        lead={<SavedAgentAvatar id={item.from} />}
                        href={inboxItemHref(item)}
                      >
                        <Outcome item={item} />
                        <span className="dl-tag">{answerLabel(item)}</span>
                      </Item>
                    ))}
                  </Group>
                </section>
              )
            );
          })}
        </div>
      </div>
    </>
  );
}
