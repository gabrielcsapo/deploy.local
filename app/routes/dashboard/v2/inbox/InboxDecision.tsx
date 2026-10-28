'use client';
import { useState } from 'react';
import { Action, Approval, Banner, Dialog, Field, Skeleton } from '@/components/ui';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { useInbox } from '../data/hooks';

export function agentName(id: string) {
  return id === 'scout' ? 'Scout' : id === 'warden' ? 'Warden' : id;
}
export function answerLabel(item: InboxItem) {
  return item.actions.find((action) => action.id === item.answer?.actionId)?.label || 'Answered';
}
export function answerDetails(item: InboxItem) {
  const answer = item.answer;
  if (!answer) return 'Answered · details unavailable';
  const platform = { web: 'web', iphone: 'iPhone', desktop: 'desktop', cli: 'CLI' }[answer.on];
  return `${answer.by} · ${platform} · ${new Date(answer.at).toLocaleString()}${answer.note ? ` · “${answer.note}”` : ''}`;
}

/** Render ConversationEvent.kind === 'decision' with its inboxItemId. */
export function InboxDecision({ itemId }: { itemId: string }) {
  const inbox = useInbox();
  const item = inbox.items.find((entry) => entry.id === itemId);
  if (!item) {
    if (inbox.loading) return <Skeleton rows={1} label="Loading decision" />;
    return (
      <Banner
        title={inbox.error || 'This decision is unavailable.'}
        action={<Action onClick={inbox.retry}>Retry</Action>}
      />
    );
  }
  return <Decision item={item} />;
}

function Decision({ item }: { item: InboxItem }) {
  const { answer } = useInbox();
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirmation, setConfirmation] = useState<InboxItem['actions'][number] | null>(null);
  async function submit(actionId: string) {
    if (pending) return;
    setPending(true);
    setError('');
    setConfirmation(null);
    try {
      const result = await answer(item.id, actionId, note);
      setConflict(result?.conflict ?? false);
    } catch {
      setError('Your answer could not be saved. Try again.');
    } finally {
      setPending(false);
    }
  }
  const closed = item.state !== 'waiting';
  return (
    <div className="dl-inbox-decision" id={`decision-${item.id}`}>
      <Approval
        title={item.title}
        text={
          closed ? (
            item.state === 'answered' ? (
              answerLabel(item)
            ) : item.state === 'expired' ? (
              'Expired'
            ) : (
              'Withdrawn'
            )
          ) : (
            <>
              {item.text !== item.title && (
                <>
                  {item.text}
                  <br />
                </>
              )}
              {agentName(item.from)} asked · {new Date(item.createdAt).toLocaleString()}
            </>
          )
        }
        answer={
          closed
            ? {
                by: item.answer?.by || 'Details unavailable',
                on: item.answer?.on || item.state,
                at: item.answer ? new Date(item.answer.at).toLocaleString() : '',
                note: item.answer?.note,
              }
            : undefined
        }
        actions={
          <>
            {item.actions.some((action) => action.id === 'answer') && (
              <div className="dl-inbox-note">
                <Field
                  label="Your answer"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  disabled={pending}
                  maxLength={10000}
                />
              </div>
            )}
            {item.actions.map((action) => (
              <Action
                key={action.id}
                variant={action.primary ? 'primary' : 'secondary'}
                disabled={pending || (action.id === 'answer' && !note.trim())}
                onClick={() => (action.confirm ? setConfirmation(action) : void submit(action.id))}
              >
                {action.label}
              </Action>
            ))}
          </>
        }
      />
      {pending && (
        <p className="dl-meta" role="status">
          Saving your answer…
        </p>
      )}
      {conflict && (
        <p className="dl-meta" role="status">
          Already answered elsewhere. The saved answer is shown above.
        </p>
      )}
      {error && <Banner kind="danger" title={error} />}
      <Dialog
        open={!!confirmation && !closed}
        onClose={() => setConfirmation(null)}
        title={item.title}
        actions={
          <>
            <Action onClick={() => setConfirmation(null)}>Cancel</Action>
            <Action variant="primary" onClick={() => confirmation && void submit(confirmation.id)}>
              {confirmation?.label}
            </Action>
          </>
        }
      >
        <p>{confirmation?.confirm}</p>
      </Dialog>
    </div>
  );
}
