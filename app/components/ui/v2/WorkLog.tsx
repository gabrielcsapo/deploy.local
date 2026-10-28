'use client';
import { useId, useState } from 'react';
import { type ComponentState, Icon, stateProps } from './shared';
import { Steps, type WorkStep } from './Steps';
export function WorkLog({
  summary,
  steps = [],
  live,
  defaultOpen = false,
  disabled,
  loading,
}: ComponentState & {
  summary: string;
  steps?: WorkStep[];
  live?: boolean;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  if (!steps.length)
    return (
      <div className="dl-worklog" {...stateProps({ disabled, loading })}>
        <span className="dl-worklog-live">
          {live && <Icon name="running" className="dl-run dl-spin" size={14} />}
          {summary}
        </span>
      </div>
    );
  return (
    <div className="dl-worklog" {...stateProps({ disabled, loading })}>
      <button
        type="button"
        className={live ? 'dl-worklog-live' : 'dl-worklog-toggle'}
        aria-expanded={open}
        aria-controls={id}
        disabled={disabled || loading}
        onClick={() => setOpen(!open)}
      >
        {live && <Icon name="running" className="dl-run dl-spin" size={14} />}
        {summary}
        <Icon name={open ? 'down' : 'chevron'} size={14} />
      </button>
      <div id={id} hidden={!open}>
        <Steps steps={steps} />
      </div>
    </div>
  );
}
