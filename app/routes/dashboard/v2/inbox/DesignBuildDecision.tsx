'use client';
import { Action } from '@/components/ui';
import type { InboxItem } from '../../../../../shared/v2/contracts';
import { SavedAgentAvatar } from '../agents/identity';
import { BuildComparison } from '../design/BuildComparison';

export function DesignBuildDecision({
  item,
  name,
  pending,
  submit,
}: {
  item: InboxItem;
  name: string;
  pending: boolean;
  submit: (actionId: string) => void;
}) {
  const check = item.designCheck!;
  const board = check.boards.find((entry) => entry.file === check.board) ?? check.boards[0];
  const taskHref = `/dashboard/tasks/${encodeURIComponent(item.taskId!)}`;
  return (
    <article className="dl-build-report">
      <h1 className="dl-title">{item.title}</h1>
      <div className="dl-who-line">
        <SavedAgentAvatar id={item.from} />
        <span>
          {name} · {item.projectName ?? item.projectId}
        </span>
      </div>
      <p className="dl-section-sub">Design check · Waiting on you</p>
      <section className="dl-section">
        <h2 className="dl-section-title">What differs</h2>
        <p className="dl-reply">{check.text}</p>
        <p className="dl-section-sub">
          {[
            board?.title,
            check.width && `${check.width} px`,
            `${check.appCommit ? `the app at ${check.appCommit.slice(0, 7)}, ` : ''}the design at ${check.commit.slice(0, 7)}`,
          ]
            .filter(Boolean)
            .join(' · ')}
          .
        </p>
      </section>
      {board && (
        <BuildComparison
          key={`${check.commit}:${board.file}:${check.width}:${check.at}`}
          projectId={check.projectId}
          commit={check.commit}
          board={board}
          width={check.width}
          captures={[
            ...(check.capture ? [check.capture] : []),
            ...(check.comparisons?.filter((pair) => pair.board === board.file) ?? []),
          ]}
        />
      )}
      {check.why && (
        <section className="dl-section">
          <h2 className="dl-section-title">Why</h2>
          <p className="dl-reply">{check.why}</p>
        </section>
      )}
      {item.state === 'waiting' && (
        <p className="dl-section-sub">
          Fix the app sends this back to {name} in the same task. Keep it has {name} change the
          board in this task to match the app; your answer is its approval, and it lands with the
          merge. The task is not ready to merge until you choose.
        </p>
      )}
      {item.state === 'waiting' ? (
        <div className="dl-approval-actions">
          {item.actions.map((action) => (
            <Action
              key={action.id}
              variant={action.primary ? 'primary' : 'secondary'}
              disabled={pending}
              onClick={() => submit(action.id)}
            >
              {action.label}
            </Action>
          ))}
          <a className="dl-btn quiet" href={taskHref}>
            Open the task
          </a>
        </div>
      ) : item.answer?.actionId === 'fix-app' ? (
        <p className="dl-approval answered">
          Sent back · {name} is making the app match the design ·{' '}
          <a className="dl-link" href={taskHref}>
            Open task
          </a>
        </p>
      ) : (
        <p className="dl-approval answered">
          Kept · {name} is changing the {board?.title ?? 'approved'} board to match the app ·{' '}
          <a className="dl-link" href={taskHref}>
            Open task
          </a>
        </p>
      )}
    </article>
  );
}
