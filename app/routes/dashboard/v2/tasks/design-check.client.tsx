'use client';
import { useState } from 'react';
import { Action, Dialog, Icon } from '@/components/ui';
import { formatTime } from '../data/time';
import { BuildComparison } from '../design/BuildComparison';
import type { TaskView } from './types';

export function ApprovedDesignCheck({ view }: { view: TaskView }) {
  const [compare, setCompare] = useState(false);
  const check = view.designCheck;
  if (!check) return null;
  const passed = check.state === 'matches' || check.state === 'kept';
  const widths = [...new Set(check.boards.flatMap((board) => board.widths))].join(' and ');
  const name = view.agent?.name ?? 'The builder';
  return (
    <section className="dl-section">
      <div className="dl-task-check-head">
        <h2 className="dl-section-title">Approved design</h2>
        <span className="dl-meta">
          {check.title} · approved {formatTime(check.approvedAt, 'day').toLowerCase()}{' '}
          {formatTime(check.approvedAt, 'clock')} · on main as {check.commit.slice(0, 7)}
        </span>
        <span className="dl-end">
          <a className="dl-btn secondary" href={check.reviewHref}>
            Open the design
          </a>
        </span>
      </div>
      <div className="dl-group">
        <div className="dl-item dl-task-check">
          <Icon name={passed ? 'check' : 'clock'} className={passed ? 'dl-ok' : 'dl-wait'} />
          <span className="dl-t">
            <span>Matches the approved design</span>
            <span>
              {passed && check.captures !== undefined
                ? `${check.captures} captures compared with the board · ${widths} px`
                : `${check.boards.length} board${check.boards.length === 1 ? '' : 's'} at ${widths} px`}
            </span>
          </span>
          <span className="dl-c dl-task-check-result">
            {passed
              ? check.state === 'kept'
                ? 'Kept'
                : 'Matches'
              : check.state === 'differs'
                ? 'Waiting on you'
                : 'Not reported yet'}
          </span>
          {passed && check.at && <span className="dl-c">{formatTime(check.at)}</span>}
          {check.state === 'differs' && check.decisionHref ? (
            <a className="dl-btn quiet dl-task-log" href={check.decisionHref}>
              Compare
            </a>
          ) : (
            passed && (
              <Action variant="quiet" className="dl-task-log" onClick={() => setCompare(true)}>
                Compare
              </Action>
            )
          )}
        </div>
      </div>
      <p className="dl-meta dl-build-check-note">
        {passed
          ? `${name} compared the running app with the approved boards at their widths.`
          : `${name} compares the running app with the approved boards at their widths and reports here. The task is not ready to merge until it has.`}
      </p>
      <Dialog open={compare} onClose={() => setCompare(false)} title="Approved design">
        {check.boards.map((board) => (
          <BuildComparison
            key={board.file}
            projectId={view.project!.id}
            commit={check.commit}
            board={board}
            captures={
              check.comparisons?.filter((pair) => pair.board === board.file) ??
              view.screenshots
                .filter((shot) => shot.id === check.screenshotId && board.file === check.board)
                .map((shot) => ({ image: shot.image, width: check.width!, height: board.height }))
            }
          />
        ))}
      </Dialog>
    </section>
  );
}
