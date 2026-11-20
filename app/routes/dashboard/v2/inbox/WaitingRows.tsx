'use client';
import { Action, Icon, type IconName } from '@/components/ui';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { DecisionFeedback, useDecision } from './InboxDecision';
import { answerDetails, answerLabel } from './presentation';
import { rowAction, waitingHref, waitingKind, type WaitingKind } from './waiting';

const kindIcons: Record<WaitingKind, IconName> = {
  risk: 'undo',
  design: 'frame',
  proposal: 'bulb',
  learning: 'spark',
  question: 'comment',
};

/** The kind mark: what kind of decision an item is, as a tinted tile with a line icon. */
export function KindTile({ kind, large }: { kind: WaitingKind; large?: boolean }) {
  return (
    <span className={`dl-tile k-${kind}${large ? ' lg' : ''}`}>
      <Icon name={kindIcons[kind]} size={large ? 18 : 16} />
    </span>
  );
}

/** One compact row: kind mark, the change in words, one line of context and one action. */
export function WaitingRow({
  item,
  context,
  on,
}: {
  item: InboxItem;
  context: string;
  on: boolean;
}) {
  const href = waitingHref(item);
  return (
    <div className={`dl-asks-row${on ? ' on' : ''}`} id={`decision-${item.id}`}>
      <KindTile kind={waitingKind(item)} />
      <a className="dl-t" href={href} aria-current={on ? 'true' : undefined}>
        <b>{item.title}</b>
        <span>{context}</span>
      </a>
      {item.state === 'waiting' ? (
        <a href={href} className="dl-btn secondary">
          {rowAction(item)}
        </a>
      ) : (
        <span className="dl-meta">{answerLabel(item)}</span>
      )}
    </div>
  );
}

/** A Decide now item: a raised card with both choices inline. */
export function RiskCard({ item, context }: { item: InboxItem; context: string }) {
  const decision = useDecision(item);
  return (
    <article className="dl-asks-risk" id={`decision-${item.id}`}>
      <div className="dl-asks-risk-top">
        <KindTile kind="risk" />
        <span className="dl-t">
          <b>{item.title}</b>
          <span>{context}</span>
        </span>
      </div>
      {item.text && item.text !== item.title && <p>{item.text}</p>}
      {item.state === 'waiting' ? (
        <div className="dl-asks-risk-actions">
          {item.actions.map((action) => (
            <Action
              key={action.id}
              variant={action.primary ? 'primary' : 'secondary'}
              disabled={decision.pending}
              onClick={() => decision.choose(action)}
            >
              {action.label}
            </Action>
          ))}
        </div>
      ) : (
        <p>
          {answerLabel(item)} ·{' '}
          {item.state === 'answered'
            ? answerDetails(item)
            : item.state === 'expired'
              ? 'Expired'
              : 'Withdrawn'}
        </p>
      )}
      <DecisionFeedback item={item} decision={decision} />
    </article>
  );
}
