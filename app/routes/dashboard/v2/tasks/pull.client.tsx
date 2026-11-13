'use client';
import { useProjectFormatting } from '../projects/formatting.ts';
import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Action, Banner, Diff, Group, Icon, Item, Skeleton } from '@/components/ui';
import { useData } from '../projects/data';
import { projectPath, projectSegment } from '../projects/routing';
import { type RepositoryCommit } from '../projects/code';
import { parsePatch } from './api';
import type { TaskDiff, TaskPull } from './types';

export default function PullRequest({ project, id }: { project: string; id: string }) {
  const { repositoryTime } = useProjectFormatting();
  const base = `/api/workspace/projects/${projectSegment(project)}/pulls/${projectSegment(id)}`;
  const detail = useData<{ record: TaskPull }>(base);
  const changes = useData<TaskDiff & { commits: RepositoryCommit[]; commitCount: number }>(
    `${base}/diff`,
  );
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const pull = detail.data?.record;
  const files = parsePatch(changes.data?.patch || '');
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  function fileDiff(file: (typeof files)[number], index: number) {
    const open = folded[file.file] ?? index === 0;
    return (
      <div key={file.file} className={open ? 'v2-pr-diff-open' : index === 0 ? 'dl-group' : ''}>
        <button
          type="button"
          className={open ? 'v2-pr-diff-toggle' : 'dl-item v2-pr-file'}
          aria-expanded={open}
          aria-controls={`pull-file-${index}`}
          onClick={() => setFolded((value) => ({ ...value, [file.file]: !open }))}
        >
          <Icon name={open ? 'down' : 'chevron'} size={14} />
          {open ? (
            <span className="dl-sr">Fold {file.file}</span>
          ) : (
            <>
              <span className="dl-t">{file.file}</span>
              <span className="dl-c">
                <span className="dl-add">+{file.added}</span>{' '}
                <span className="dl-del">−{file.removed}</span>
              </span>
            </>
          )}
        </button>
        <div id={`pull-file-${index}`} hidden={!open}>
          {open && <Diff file={file.file} lines={file.lines} />}
        </div>
      </div>
    );
  }
  return (
    <>
      {detail.error && (
        <Banner title={detail.error} action={<Action onClick={detail.refresh}>Retry</Action>} />
      )}
      {!pull && !detail.error && <Skeleton rows={6} />}
      {pull && (
        <>
          <div className="v2-pr-head">
            <h1 className="dl-title">
              {pull.title} <span className="v2-pr-number">#{pull.number}</span>
            </h1>
            <div className="v2-pr-state">
              <span className="dl-tag">
                <Icon name="merge" size={14} />
                {pull.status[0].toUpperCase() + pull.status.slice(1)}
              </span>
              <span>
                {(() => {
                  const who =
                    pull.status === 'merged'
                      ? pull.mergedByName || pull.mergedBy
                      : pull.status === 'closed'
                        ? pull.closedByName || pull.closedBy
                        : pull.authorName || pull.author;
                  const count = changes.data?.commitCount;
                  const did =
                    pull.status === 'merged'
                      ? count === undefined
                        ? 'merged'
                        : `merged ${count} commit${count === 1 ? '' : 's'}`
                      : pull.status === 'closed'
                        ? 'closed changes'
                        : 'proposes changes';
                  // Who did it when it was recorded; the sentence still reads without them.
                  return who ? (
                    <>
                      <span className="dl-strong">{who}</span> {did} into{' '}
                    </>
                  ) : (
                    <>{did[0].toUpperCase() + did.slice(1)} into </>
                  );
                })()}
                <span className="v2-pr-ref">{pull.targetBranch}</span> from{' '}
                <span className="v2-pr-ref">{pull.sourceBranch}</span>{' '}
                {repositoryTime(pull.mergedAt || pull.closedAt || pull.createdAt)}
              </span>
            </div>
          </div>
          {!pull.taskIds?.length && (
            <div className="dl-notice v2-pr-notice">
              <Icon name="branch" />
              <span>
                Opened from a branch, not by a task, so there is no conversation.{' '}
                {pull.status === 'merged'
                  ? 'It shows what was merged.'
                  : pull.status === 'closed'
                    ? 'It shows what was closed.'
                    : 'It shows the proposed changes.'}
              </span>
              <span className="dl-end">
                <a href="/dashboard" className="dl-btn secondary">
                  Follow up in a task
                </a>
              </span>
            </div>
          )}
          <Group
            title={
              <>
                <span className="dl-avatar v2-pr-avatar">
                  {(pull.authorName || pull.author)?.slice(0, 1) || '?'}
                </span>
                {pull.authorName || pull.author ? (
                  <>
                    <span className="dl-strong">{pull.authorName || pull.author}</span>
                    <span>opened this {repositoryTime(pull.createdAt)}</span>
                  </>
                ) : (
                  <span>Opened {repositoryTime(pull.createdAt)}</span>
                )}
              </>
            }
          >
            <div className="v2-pr-description">
              <Markdown remarkPlugins={[remarkGfm]}>
                {pull.body || 'No description provided.'}
              </Markdown>
            </div>
            <Item
              lead={
                <Icon
                  name={
                    pull.checkCount && pull.checksPassed === pull.checkCount ? 'check' : 'clock'
                  }
                />
              }
              title={
                pull.checkCount
                  ? `${pull.checksPassed} checks passed`
                  : 'No checks recorded on this version'
              }
              end={
                pull.checkCount ? (
                  <>
                    on <span className="dl-mono">{pull.checksCommit?.slice(0, 7)}</span>
                  </>
                ) : undefined
              }
            />
            {pull.status === 'merged' && (
              <Item
                lead={<Icon name="merge" />}
                title={`Merged into ${pull.targetBranch}${pull.mergedBy ? ` by ${pull.mergedByName || pull.mergedBy}` : ''}`}
                end={
                  <>
                    <span className="dl-mono">
                      {(pull.mergedTargetCommit || pull.mergedCommit)?.slice(0, 7)}
                    </span>{' '}
                    · {repositoryTime(pull.mergedAt)}
                  </>
                }
              />
            )}
            {pull.status === 'closed' && (
              <Item
                lead={<Icon name="close" />}
                title={`Closed${pull.closedBy ? ` by ${pull.closedByName || pull.closedBy}` : ''}`}
                end={repositoryTime(pull.closedAt)}
              />
            )}
            {pull.release && (
              <Item
                lead={<Icon name="check" />}
                title="Released"
                end={repositoryTime(pull.release.at)}
                href={`${projectPath(project)}/releases/${projectSegment(pull.release.id)}`}
              />
            )}
          </Group>
          {changes.error && (
            <Banner
              title={changes.error}
              action={<Action onClick={changes.refresh}>Retry</Action>}
            />
          )}
          {!changes.data && !changes.error && <Skeleton rows={5} />}
          {changes.data && (
            <>
              <section className="dl-section">
                <h2 className="dl-section-title">
                  Commits <span className="v2-pr-number">{changes.data.commitCount}</span>
                </h2>
                <Group>
                  {changes.data.commits.map((commit) => (
                    <Item
                      key={commit.oid}
                      lead={
                        <span className="dl-avatar v2-pr-avatar">{commit.author.slice(0, 1)}</span>
                      }
                      title={commit.subject}
                      description={`${commit.author} · ${repositoryTime(commit.date)}`}
                      end={<span className="dl-mono">{commit.oid.slice(0, 7)}</span>}
                      href={`${projectPath(project)}/code?ref=${commit.oid}&history=true`}
                    />
                  ))}
                </Group>
                {changes.data.commitCount > changes.data.commits.length && (
                  <p className="dl-meta">
                    Showing {changes.data.commits.length} of {changes.data.commitCount} commits.
                  </p>
                )}
              </section>
              <section className="dl-section">
                <h2 className="dl-section-title">
                  Files changed <span className="v2-pr-number">{files.length}</span>{' '}
                  <span className="dl-add v2-pr-total">+{added}</span>{' '}
                  <span className="dl-del v2-pr-total">−{removed}</span>
                </h2>
                <div className="v2-pr-diffs">
                  {files[0] && fileDiff(files[0], 0)}
                  {files.length > 1 && (
                    <div className="dl-group">
                      {files.slice(1).map((file, index) => fileDiff(file, index + 1))}
                    </div>
                  )}
                </div>
              </section>
            </>
          )}
        </>
      )}
    </>
  );
}
