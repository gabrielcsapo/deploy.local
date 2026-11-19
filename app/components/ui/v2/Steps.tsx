'use client';
import { useEffect, useState, type ReactNode } from 'react';
import type { StepDetail } from '../../../../shared/v2/contracts';
import { type ComponentState, type IconName, Icon, stateProps } from './shared';
import { Skeleton } from './Skeleton';
export type WorkStep = {
  text: ReactNode;
  icon?: IconName;
  /** dl-run, dl-ok or dl-fail, to color the icon by its state. */
  iconClass?: string;
  detail?: string;
  added?: number;
  removed?: number;
  /** How it went, beside the step: "Live at drop.local", "Failed: health check". */
  outcome?: string;
  outcomeHref?: string;
  tone?: 'fail' | 'warn';
  /** What the agent said while it worked: a line that wraps instead of truncating. */
  note?: boolean;
  /** Still running: the icon becomes a spinner. */
  live?: boolean;
  seconds?: number;
  links?: { label: string; href: string }[];
  /** Why it failed or stopped, and its last log lines; the step opens to show them. */
  reason?: string;
  tail?: string[];
  /** What a search found, at the row's end: "3 files". */
  found?: string;
  /** Loads what the step did when it opens: the command and output, the diff, the matches. */
  load?: () => Promise<StepDetail>;
};

/** The command and the end of its output, or a search and what it found. */
function Output({ detail }: { detail: StepDetail }) {
  const lines = detail.output ?? detail.found ?? [];
  if (!detail.command && !lines.length) return null;
  return (
    <pre className="dl-step-tail">
      {detail.command && (
        <span className="dl-step-cmd">
          {detail.found ? detail.command : `$ ${detail.command}`}
          {lines.length || (detail.output && detail.more) ? '\n' : ''}
        </span>
      )}
      {detail.output && detail.more ? `… ${detail.more} earlier lines\n` : ''}
      {lines.join('\n')}
      {detail.found && detail.more ? `\n… ${detail.more} more` : ''}
    </pre>
  );
}

function Diff({ detail }: { detail: StepDetail }) {
  if (!detail.diff?.length) return null;
  return (
    <div className="dl-lines dl-step-diff">
      {detail.diff.map((row, index) => (
        <span key={index} className={`dl-line${row.kind === 'same' ? '' : ` ${row.kind}`}`}>
          <span className="dl-n">{row.old ?? ''}</span>
          <span className="dl-n">{row.new ?? ''}</span>
          <span>{row.text}</span>
        </span>
      ))}
      {detail.more ? (
        <span className="dl-line hunk">
          <span className="dl-n" />
          <span className="dl-n" />
          <span>… {detail.more} more lines</span>
        </span>
      ) : null}
    </div>
  );
}

/** What opening a step shows, loaded the first time it opens. */
function Detail({ load }: { load: () => Promise<StepDetail> }) {
  const [detail, setDetail] = useState<StepDetail | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    load()
      .then((value) => active && setDetail(value))
      .catch(() => active && setFailed(true));
    return () => {
      active = false;
    };
  }, [load]);
  if (failed) return <p className="dl-meta">Couldn’t load this step</p>;
  if (!detail) return <Skeleton rows={2} label="Loading this step" />;
  return (
    <>
      {detail.path && <p className="dl-step-path">{detail.path}</p>}
      <Diff detail={detail} />
      <Output detail={detail} />
    </>
  );
}

export function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

/** "Live at drop.local" links the address, not the words before it. */
function Outcome({ step }: { step: WorkStep }) {
  if (!step.outcomeHref) return <>{step.outcome}</>;
  const at = step.outcome?.match(/^(.*\bat )(.+)$/);
  return at ? (
    <>
      {at[1]}
      <a href={step.outcomeHref}>{at[2]}</a>
    </>
  ) : (
    <a href={step.outcomeHref}>{step.outcome}</a>
  );
}

function Step({ step, index, numbered }: { step: WorkStep; index: number; numbered?: boolean }) {
  const opens = Boolean(step.reason || step.tail?.length || step.load);
  // A failure is the thing to read, so it starts open.
  const [open, setOpen] = useState(step.tone === 'fail');
  return (
    <>
      <li className={`dl-step${step.note ? ' note' : ''}`}>
        <span className="dl-i" aria-hidden={numbered || undefined}>
          {numbered ? (
            index + 1
          ) : step.live ? (
            <Icon name="running" size={14} className="dl-run dl-spin" />
          ) : (
            <Icon name={step.icon || 'file'} size={14} className={step.iconClass} />
          )}
        </span>
        <span className="dl-t">{step.text}</span>
        {step.detail && <span className="dl-x">{step.detail}</span>}
        {step.outcome && (
          <span className={`dl-x${step.tone ? ` ${step.tone}` : ''}`}>
            <Outcome step={step} />
          </span>
        )}
        {step.added !== undefined && <span className="dl-add">+{step.added}</span>}
        {step.removed !== undefined && <span className="dl-del">−{step.removed}</span>}
        {(step.seconds !== undefined || step.links?.length || step.found || opens) && (
          <span className="dl-step-end">
            {step.found && <span>{step.found}</span>}
            {step.seconds !== undefined && <span>{duration(step.seconds)}</span>}
            {step.links?.map((link) => (
              <a key={link.href + link.label} href={link.href}>
                {link.label}
              </a>
            ))}
            {opens && (
              <button
                type="button"
                className="dl-step-toggle"
                aria-expanded={open}
                aria-label={
                  step.load
                    ? open
                      ? 'Hide details'
                      : 'Show details'
                    : open
                      ? 'Hide why'
                      : 'Show why'
                }
                onClick={() => setOpen(!open)}
              >
                <Icon name={open ? 'down' : 'chevron'} size={14} />
              </button>
            )}
          </span>
        )}
      </li>
      {opens && open && (
        <li className="dl-step-open">
          {step.reason && <p>{step.reason}</p>}
          {step.tail?.length ? <pre className="dl-step-tail">{step.tail.join('\n')}</pre> : null}
          {step.load && <Detail load={step.load} />}
        </li>
      )}
    </>
  );
}

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
        <Step key={index} step={step} index={index} numbered={numbered} />
      ))}
    </List>
  );
}
