'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { StepDetail } from '../../../../shared/v2/contracts';
import { type ComponentState, type IconName, Icon, stateProps } from './shared';
import { Skeleton } from './Skeleton';
export type WorkStep = {
  /** Keeps a step's open state with the step when steps before it arrive or change. */
  id?: string;
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
  /** When a running step started: its time counts up beside it. */
  since?: string;
  /** A running step that opens by itself and keeps its detail current, like a deploy's build log. */
  follows?: boolean;
};

/** How often a running step's detail is loaded again. */
const REFRESH_MS = 2000;

/** The command and the end of its output, or a search and what it found. */
function Output({ detail, live }: { detail: StepDetail; live?: boolean }) {
  const lines = detail.output ?? detail.found ?? [];
  if (!detail.command && !lines.length) return null;
  return (
    <pre className="dl-step-tail" aria-live={live ? 'polite' : undefined}>
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

/**
 * What opening a step shows, loaded the first time it opens. While the step runs it loads again
 * every couple of seconds, and once more when it finishes.
 */
function Detail({ load, live }: { load: () => Promise<StepDetail>; live?: boolean }) {
  const [detail, setDetail] = useState<StepDetail | null>(null);
  const [failed, setFailed] = useState(false);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  useEffect(() => {
    let active = true;
    const fetchDetail = () =>
      loader
        .current()
        .then((value) => {
          if (!active) return;
          setDetail(value);
          setFailed(false);
        })
        // A running step that misses one load keeps what it had and tries again.
        .catch(() => active && !live && setFailed(true));
    fetchDetail();
    const timer = live ? setInterval(fetchDetail, REFRESH_MS) : undefined;
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [live]);
  if (failed) return <p className="dl-meta">Couldn’t load this step</p>;
  if (!detail) return <Skeleton rows={2} label="Loading this step" />;
  return (
    <>
      {detail.path && <p className="dl-step-path">{detail.path}</p>}
      <Diff detail={detail} />
      <Output detail={detail} live={live} />
    </>
  );
}

export function duration(seconds: number) {
  if (seconds < 60) return `${seconds}s`;
  if (seconds >= 3600) {
    const minutes = Math.floor(seconds / 60);
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  }
  const minutes = Math.floor(seconds / 60);
  return seconds % 60 ? `${minutes}m ${seconds % 60}s` : `${minutes}m`;
}

/** A running step's own time, counting up every second. */
function Running({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - Date.parse(since)) / 1000));
  return <span>{duration(seconds)}</span>;
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
  // A failure is the thing to read, so it starts open; so does a deploy as it goes.
  const [open, setOpen] = useState(step.tone === 'fail' || Boolean(step.live && step.follows));
  // A deploy that starts running after the row appeared opens then.
  const follows = Boolean(step.live && step.follows);
  const [following, setFollowing] = useState(follows);
  if (follows !== following) {
    setFollowing(follows);
    if (follows) setOpen(true);
  }
  const running = step.live && step.since && step.seconds === undefined ? step.since : undefined;
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
        {(step.seconds !== undefined || running || step.links?.length || step.found || opens) && (
          <span className="dl-step-end">
            {step.found && <span>{step.found}</span>}
            {step.seconds !== undefined && <span>{duration(step.seconds)}</span>}
            {running && <Running since={running} />}
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
          {step.load && <Detail load={step.load} live={step.live} />}
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
        <Step key={step.id ?? index} step={step} index={index} numbered={numbered} />
      ))}
    </List>
  );
}
