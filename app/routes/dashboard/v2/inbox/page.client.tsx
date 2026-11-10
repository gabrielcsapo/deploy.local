'use client';
import { SavedAgentAvatar } from '../agents/identity';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Empty,
  Group,
  Head,
  IconButton,
  Item,
  Skeleton,
  Tabs,
} from '@/components/ui';
import { useAgentName, useInbox } from '../data/hooks';
import { dayLabel } from '../data/sidebar';
import { DesignItemReview } from '../design/ItemReview';
import { answerDetails, answerLabel, InboxDecision, Outcome } from './InboxDecision';

export default function Inbox() {
  const agentName = useAgentName();
  const [params] = useSearchParams();
  const answered = params.get('tab') === 'answered';
  const selected = params.get('item');
  const inbox = useInbox();
  const waiting = inbox.items.filter((item) => item.state === 'waiting');
  // Keep a decision mounted when it is answered here or in another client.
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
  const history = inbox.items
    .filter((item) => item.state === 'answered')
    .sort(
      (a, b) => Date.parse(b.answer?.at || b.createdAt) - Date.parse(a.answer?.at || a.createdAt),
    );
  const cards = inbox.items
    .filter((item) => item.state === 'waiting' || seen.includes(item.id) || item.id === selected)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  useEffect(() => {
    if (selected)
      document.getElementById(`decision-${selected}`)?.scrollIntoView({ block: 'center' });
  }, [selected, inbox.loading]);
  // A design item opens as its review: what changed, Before and After, then the decision.
  const design = selected?.startsWith('design:')
    ? inbox.items.find((item) => item.id === selected)
    : undefined;
  const question =
    !answered && selected
      ? inbox.items.find((item) => item.id === selected && item.kind === 'question')
      : undefined;
  const build = selected
    ? inbox.items.find((item) => item.id === selected && item.designCheck)
    : undefined;
  if (design) return <DesignItemReview key={design.id} item={design} />;
  return (
    <>
      <Head
        title="Waiting on you"
        menu={
          <IconButton
            icon="menu"
            label="Show sidebar"
            className="dl-menu-btn"
            onClick={() => window.dispatchEvent(new Event('deploy:v2-sidebar'))}
          />
        }
        actions={
          build ? (
            <a className="dl-link" href="/dashboard/inbox">
              Waiting on you
            </a>
          ) : (
            <IconButton icon="search" label="Search (coming soon)" disabled />
          )
        }
      />
      <div className="dl-scroll">
        <div className={question ? 'dl-decision-column' : 'dl-page'}>
          {build ? (
            <InboxDecision key={build.id} itemId={build.id} />
          ) : question ? (
            <InboxDecision key={question.id} itemId={question.id} />
          ) : (
            <>
              <div className="dl-page-head">
                <div className="dl-t">
                  <h1 className="dl-title">Waiting on you</h1>
                  <span className="dl-meta">
                    Every decision your agents asked for. Answering anywhere answers everywhere.
                  </span>
                </div>
              </div>
              <Tabs
                label="Decisions"
                value={answered ? '/dashboard/inbox?tab=answered' : '/dashboard/inbox'}
                items={[
                  {
                    label: 'Waiting',
                    href: '/dashboard/inbox',
                    count: inbox.loading || inbox.error ? undefined : waiting.length,
                  },
                  { label: 'Answered', href: '/dashboard/inbox?tab=answered' },
                ]}
              />
              {inbox.error && (
                <Banner title={inbox.error} action={<Action onClick={inbox.retry}>Retry</Action>} />
              )}
              {inbox.loading ? (
                <Skeleton label="Loading decisions" />
              ) : answered ? (
                <>
                  {history.length === 0 && !inbox.error && (
                    <Empty title="No answers yet">Decisions you answer appear here.</Empty>
                  )}
                  {['Today', 'Yesterday', 'Earlier'].map((day) => {
                    const items = history.filter(
                      (item) => dayLabel(item.answer?.at || item.createdAt) === day,
                    );
                    return (
                      items.length > 0 && (
                        <section className="dl-section dl-inbox-section" key={day}>
                          <h2 className="dl-section-title">{day}</h2>
                          <Group>
                            {items.map((item) => (
                              <Item
                                key={item.id}
                                title={item.title}
                                description={`${item.fromName || agentName(item.from)} asked · ${answerDetails(item)}`}
                                lead={<SavedAgentAvatar id={item.from} />}
                                href={`/dashboard/inbox?item=${encodeURIComponent(item.id)}`}
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
                </>
              ) : (
                <>
                  {cards.length === 0 && !inbox.error && (
                    <Empty title="Nothing waiting on you">
                      When an agent needs a decision, it appears here.
                    </Empty>
                  )}
                  {cards.map((item) => (
                    <InboxDecision key={item.id} itemId={item.id} />
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
