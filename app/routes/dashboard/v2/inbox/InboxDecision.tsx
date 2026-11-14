'use client';
import { SavedAgentAvatar } from '../agents/identity';
import { useState } from 'react';
import { Action, Approval, Banner, Dialog, Field, Skeleton, Status } from '@/components/ui';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { useAgentName, useInbox } from '../data/hooks';
import { useProjectFormatting } from '../projects/formatting';
import { DesignCard } from '../design/Review';

import { QuestionDecision } from './QuestionDecision';
import { DesignBuildDecision } from './DesignBuildDecision';
import { answerDetails, answerLabel } from './presentation';
export { agentName, answerDetails, answerLabel } from './presentation';

export function Outcome({ item }: { item: InboxItem }) {
  return item.outcome ? (
    <Status
      kind={
        item.outcome.tone === 'ok'
          ? 'healthy'
          : item.outcome.tone === 'failed'
            ? 'failed'
            : 'inactive'
      }
    >
      {item.outcome.text}
    </Status>
  ) : null;
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
  const { formatTime } = useProjectFormatting();
  const { answer } = useInbox();
  const agentName = useAgentName();
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
  const name = item.fromName || agentName(item.from);
  if (item.id.startsWith('design:') && (!closed || item.answer?.actionId === 'approve'))
    return (
      <DesignCard
        projectId={item.projectId ?? item.id.split(':')[1]}
        taskId={item.taskId}
        design={{
          api: `/api/projects/${encodeURIComponent(item.projectId ?? item.id.split(':')[1])}/design`,
          proposal: item,
        }}
      />
    );
  return (
    <div className="dl-inbox-decision" id={`decision-${item.id}`}>
      {item.designCheck ? (
        <DesignBuildDecision
          item={item}
          name={name}
          pending={pending}
          submit={(action) => void submit(action)}
        />
      ) : closed ? (
        <article className="dl-approval answered">
          <div className="dl-approval-head">
            <SavedAgentAvatar id={item.from} />
            <div className="dl-t">
              <h3 className="dl-approval-title">{item.title}</h3>
              <p className="dl-approval-text">{answerLabel(item)}</p>
            </div>
            <Outcome item={item} />
          </div>
          <div className="dl-approval-answer">
            {item.state === 'answered'
              ? answerDetails(item)
              : item.state === 'expired'
                ? 'Expired'
                : 'Withdrawn'}
          </div>
        </article>
      ) : item.kind === 'question' ? (
        <QuestionDecision
          item={item}
          name={name}
          note={note}
          setNote={setNote}
          pending={pending}
          choose={(action) => (action.confirm ? setConfirmation(action) : void submit(action.id))}
        />
      ) : (
        <Approval
          title={item.title}
          text={
            <>
              {item.text !== item.title && (
                <>
                  {item.text}
                  <br />
                </>
              )}
              {name} asked · {formatTime(item.createdAt)}
            </>
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
                  onClick={() =>
                    action.confirm ? setConfirmation(action) : void submit(action.id)
                  }
                >
                  {action.label}
                </Action>
              ))}
            </>
          }
        />
      )}
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
