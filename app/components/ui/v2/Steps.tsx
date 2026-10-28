'use client';
import { type ComponentState, type IconName, Icon, stateProps } from './shared';
export type WorkStep = {
  text: string;
  icon?: IconName;
  detail?: string;
  added?: number;
  removed?: number;
};
export function Steps({ steps, disabled, loading }: ComponentState & { steps: WorkStep[] }) {
  return (
    <ul className="dl-steps" {...stateProps({ disabled, loading })}>
      {steps.map((step, index) => (
        <li className="dl-step" key={index}>
          <span className="dl-i">
            <Icon name={step.icon || 'file'} size={14} />
          </span>
          <span className="dl-t">{step.text}</span>
          {step.detail && <span className="dl-x">{step.detail}</span>}
          {step.added !== undefined && <span className="dl-add">+{step.added}</span>}
          {step.removed !== undefined && <span className="dl-del">−{step.removed}</span>}
        </li>
      ))}
    </ul>
  );
}
