'use client';
import type { ReactNode } from 'react';
import { type ComponentState, type IconName, Icon, stateProps } from './shared';
export function Approval({
  title,
  text,
  actions,
  answer,
  icon = 'attention',
  disabled,
  loading,
}: ComponentState & {
  title: string;
  text: ReactNode;
  actions?: ReactNode;
  answer?: { by: string; on: string; at: string; note?: string };
  icon?: IconName;
}) {
  return (
    <article
      className={`dl-approval ${answer ? 'answered' : ''}`}
      {...stateProps({ disabled, loading })}
    >
      <div className="dl-approval-head">
        <Icon
          name={answer ? 'check' : icon}
          size={18}
          className={answer ? 'dl-ok' : icon === 'attention' ? 'dl-attn' : ''}
        />
        <div className="dl-t">
          <h3 className="dl-approval-title">{title}</h3>
          <p className="dl-approval-text">{text}</p>
        </div>
      </div>
      {answer ? (
        <div className="dl-approval-answer">
          <Icon name="check" size={14} />
          <span>
            {answer.note ? `${answer.note} · ` : ''}
            {answer.by} · {answer.on} · {answer.at}
          </span>
        </div>
      ) : (
        <div className="dl-approval-actions">{actions}</div>
      )}
    </article>
  );
}
