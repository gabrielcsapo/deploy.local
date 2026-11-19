'use client';
import { Action, Icon } from '@/components/ui';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { MarkdownWithMedia } from '../conversation/Media';
import { askedTime, questionActions } from './presentation';

/**
 * A question the agent is waiting on, in its task's thread: set apart from the work, with its
 * pictures in a row. The composer below answers it; the agent's own choices stay as buttons.
 */
export function TaskQuestion({
  item,
  pending,
  choose,
}: {
  item: InboxItem;
  pending: boolean;
  choose: (action: InboxItem['actions'][number]) => void;
}) {
  const { options, dismiss } = questionActions(item);
  return (
    <section className="dl-ask" aria-label="The agent is waiting for your answer">
      <div className="dl-ask-head">
        <Icon name="attention" size={14} className="dl-ask-icon" />
        <span>Waiting for your answer</span>
        <span aria-hidden="true">·</span>
        <span>{askedTime(item.createdAt)}</span>
      </div>
      <p className="dl-ask-q">{item.text || item.title}</p>
      {item.context?.text && (
        <div className="dl-reply">
          <MarkdownWithMedia text={item.context.text} />
        </div>
      )}
      {(options.length > 0 || dismiss) && (
        <div className="dl-decision-options" role="group" aria-label="Choose an answer">
          {options.map((action) => (
            <Action
              key={action.id}
              variant={action.primary ? 'primary' : 'secondary'}
              disabled={pending}
              onClick={() => choose(action)}
            >
              {action.label}
            </Action>
          ))}
          {dismiss && (
            <Action variant="quiet" disabled={pending} onClick={() => choose(dismiss)}>
              {dismiss.label}
            </Action>
          )}
        </div>
      )}
    </section>
  );
}
