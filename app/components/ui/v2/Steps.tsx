'use client';
import type { ReactNode } from 'react';
import { type ComponentState, type IconName, Icon, stateProps } from './shared';
export type WorkStep = {
  text: ReactNode;
  icon?: IconName;
  /** dl-run, dl-ok or dl-fail, to color the icon by its state. */
  iconClass?: string;
  detail?: string;
  added?: number;
  removed?: number;
};
/**
 * A rail of steps. Work logs mark each step with an icon; `numbered` marks them
 * 1, 2, 3 as an ordered list for instructions, and lets long steps wrap.
 */
export function Steps({
  steps,
  numbered,
  disabled,
  loading,
}: ComponentState & { steps: WorkStep[]; numbered?: boolean }) {
  const List = numbered ? 'ol' : 'ul';
  return (
    <List
      className={`dl-steps${numbered ? ' numbered' : ''}`}
      {...stateProps({ disabled, loading })}
    >
      {steps.map((step, index) => (
        <li className="dl-step" key={index}>
          <span className="dl-i" aria-hidden={numbered || undefined}>
            {numbered ? (
              index + 1
            ) : (
              <Icon name={step.icon || 'file'} size={14} className={step.iconClass} />
            )}
          </span>
          <span className="dl-t">{step.text}</span>
          {step.detail && <span className="dl-x">{step.detail}</span>}
          {step.added !== undefined && <span className="dl-add">+{step.added}</span>}
          {step.removed !== undefined && <span className="dl-del">−{step.removed}</span>}
        </li>
      ))}
    </List>
  );
}
