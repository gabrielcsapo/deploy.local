'use client';
import { useProjectFormatting } from '../projects/formatting.ts';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Action, Banner, Diff, Group, Icon, Item, Skeleton } from '@/components/ui';
import { authenticatedFetch, useData } from '../projects/data';
import { projectPath, projectSegment } from '../projects/routing';
import { useCoordinatorName } from '../data/hooks';
import { newTaskOnBranch } from '../start/chosen-project';
import { submitMessage } from '../markup/client';
import { mergePull, parsePatch, workspaceCommand } from './api';
import { fileSize } from './description';
import {
  FILES_SHOWN,
  fileChange,
  filesCount,
  filterFiles,
  foldMerges,
  isImage,
  mergesLabel,
  pullDecision,
  pullTaskAsk,
  pullTaskMessage,
  type DecisionDiff,
  type MergeOperation,
  type PatchFile,
  type PullCommit,
  type PullDecision,
} from './pull-page';
import type { TaskCheck, TaskDiff, TaskPull } from './types';

type PullDetail = {
  record: TaskPull;
  mergeOperation?: (MergeOperation & { id: string }) | null;
  checks?: TaskCheck[];
};
type PullChanges = TaskDiff &
  DecisionDiff & { commits: PullCommit[]; commitCount: number; mergeBase?: string };
type Busy = 'merge' | 'close' | 'reopen' | 'retry-merge' | 'task' | null;

/** A pull request no task opened: decide it here (Merge, Close) and read what it changes. */
export default function PullRequest({ project, id }: { project: string; id: string }) {
  const { repositoryTime } = useProjectFormatting();
  const coordinator = useCoordinatorName();
  const base = `/api/projects/${projectSegment(project)}/pulls/${projectSegment(id)}`;
  const detail = useData<PullDetail>(base);
  const changes = useData<PullChanges>(`${base}/diff`);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState('');
  // The merge this page queued, until the pull request it reads says so too.
  const [queued, setQueued] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const menuItem = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    if (menu) menuItem.current?.focus();
  }, [menu]);
  const pull = detail.data?.record;
  const operation = detail.data?.mergeOperation;
  const diff = changes.data;
  const merging =
    busy === 'merge' || busy === 'retry-merge' || (!!queued && pull?.mergeOperationId !== queued);
  const decision = pull
    ? pullDecision(pull, diff, operation, { merging, time: repositoryTime })
    : null;
  const pullStatus = pull?.status;
  // While a merge runs, read it every second until it lands or fails; then read the changes
  // again, since a merged pull request shows what it merged.
  const refreshes = useRef({ detail: detail.refresh, changes: changes.refresh });
  useEffect(() => {
    refreshes.current = { detail: detail.refresh, changes: changes.refresh };
  });
  const waiting = decision?.kind === 'merging' && busy === null;
  useEffect(() => {
    if (!waiting) return;
    const timer = setInterval(() => refreshes.current.detail(), 1000);
    return () => clearInterval(timer);
  }, [waiting]);
  const seenStatus = useRef(pullStatus);
  useEffect(() => {
    if (seenStatus.current && pullStatus && seenStatus.current !== pullStatus) {
      refreshes.current.changes();
      // The project header's New task is secondary only while the pull request is open.
      window.dispatchEvent(new Event('deploy:pull-changed'));
    }
    seenStatus.current = pullStatus;
  }, [pullStatus]);
  const files = useMemo(() => parsePatch(diff?.patch || ''), [diff?.patch]);
  const added = files.reduce((total, file) => total + file.added, 0);
  const removed = files.reduce((total, file) => total + file.removed, 0);
  const projectId = pull?.projectId || project;
  const pipelines = `${projectPath(project)}/pipelines`;
  const checksRun = detail.data?.checks?.find(
    (check) => !check.source && check.commit === pull?.checksCommit,
  );

  async function act(name: Exclude<Busy, null>, action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(name);
    setError('');
    try {
      await action();
      detail.refresh();
      changes.refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not save. Try again.');
    } finally {
      setBusy(null);
    }
  }
  const command = (action: string) =>
    workspaceCommand<TaskPull>(
      authenticatedFetch,
      `/projects/${encodeURIComponent(projectId)}/pulls/${encodeURIComponent(pull!.id)}/${action}`,
      { revision: pull!.revision },
    );
  function run(action: PullDecision['actions'][number]) {
    if (!pull) return;
    if (action === 'merge')
      void act('merge', async () => {
        const saved = (await mergePull(authenticatedFetch, projectId, pull, diff!)) as TaskPull;
        if (saved.mergeOperationId) setQueued(saved.mergeOperationId);
      });
    else if (action === 'retry-merge') void act('retry-merge', () => command('retry-merge'));
    else if (action === 'close') void act('close', () => command('close'));
    else if (action === 'reopen') void act('reopen', () => command('reopen'));
    else
      void act('task', async () => {
        // A task on the pull request's branch, asked to do what the decision needs.
        const text = pullTaskMessage(pull, action, {
          conflicts: diff?.conflicts,
          failed: decision?.failed?.map((check) => check.name),
          commit: diff?.headCommit,
          run: decision?.runId
            ? `${pipelines}?run=${encodeURIComponent(decision.runId)}`
            : undefined,
        });
        const started = await submitMessage(
          { text, attachments: [] },
          undefined,
          undefined,
          projectId,
          `refs/heads/${pull.sourceBranch}`,
        );
        window.location.assign(`/dashboard/tasks/${encodeURIComponent(started.taskId)}`);
      });
  }
  const label = (action: PullDecision['actions'][number]) =>
    ({
      close: 'Close',
      merge: 'Merge',
      'update-in-task': `Update from ${pull?.targetBranch} in a task`,
      'fix-in-task': 'Fix in a task',
      'retry-merge': 'Retry merge',
      reopen: 'Reopen',
    })[action];
  const busyFor = (action: PullDecision['actions'][number]): Busy =>
    action === 'update-in-task' || action === 'fix-in-task' ? 'task' : action;
  const follow = pull
    ? pull.status === 'open'
      ? {
          label: 'Start a task on this branch',
          href: newTaskOnBranch(projectId, pull.sourceBranch, pullTaskAsk(pull)),
        }
      : {
          label: `Start a follow-up task on ${pull.targetBranch}`,
          href: newTaskOnBranch(projectId, pull.targetBranch, pullTaskAsk(pull)),
        }
    : null;

  return (
    <>
      {detail.error && (
        <Banner title={detail.error} action={<Action onClick={detail.refresh}>Retry</Action>} />
      )}
      {!pull && !detail.error && <Skeleton rows={6} />}
      {pull && (
        <>
          <div className="v2-pr-head">
            <div className="v2-pr-title-row">
              <h1 className="dl-title">
                {pull.title} <span className="v2-pr-number">#{pull.number}</span>
              </h1>
              <div
                className="v2-pr-more"
                onBlur={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && menu) {
                    setMenu(false);
                    menuButton.current?.focus();
                  }
                }}
              >
                <button
                  ref={menuButton}
                  type="button"
                  className="dl-icon-btn"
                  aria-label="More"
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  aria-controls="pull-more"
                  onClick={() => setMenu(!menu)}
                >
                  <Icon name="more" />
                </button>
                {menu && follow && (
                  <div className="dl-menu" role="menu" id="pull-more" aria-label="More">
                    <a className="dl-menu-item" role="menuitem" href={follow.href} ref={menuItem}>
                      {follow.label}
                    </a>
                  </div>
                )}
              </div>
            </div>
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
                  const count = diff?.commitCount;
                  const commits =
                    count === undefined ? '' : ` ${count} commit${count === 1 ? '' : 's'}`;
                  const did =
                    pull.status === 'merged'
                      ? `merged${commits}`
                      : pull.status === 'closed'
                        ? 'closed changes'
                        : count === undefined
                          ? 'proposes changes'
                          : `proposes${commits}`;
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
          {error && <Banner kind="danger" title={error} />}
          {decision && (
            <div className="dl-group v2-pr-decision">
              <div className="dl-item" aria-live="polite">
                <DecisionIcon kind={decision.kind} />
                <span className="dl-t">
                  <span>{decision.title}</span>
                  {decision.line && (
                    <span>
                      {decision.kind === 'checks-failed' && decision.failed ? (
                        <>
                          Required pipeline checks have not passed for{' '}
                          {diff?.headCommit?.slice(0, 7)}:{' '}
                          <Linked
                            names={decision.failed.map((check) => check.name)}
                            href={
                              decision.runId
                                ? `${pipelines}?run=${encodeURIComponent(decision.runId)}`
                                : undefined
                            }
                          />{' '}
                          failed.
                        </>
                      ) : (
                        decision.line
                      )}
                    </span>
                  )}
                </span>
                {decision.actions.length > 0 && (
                  <span className="v2-pr-actions">
                    {decision.actions.map((action) => (
                      <Action
                        key={action}
                        variant={
                          decision.primary === action
                            ? 'primary'
                            : action === 'reopen'
                              ? 'secondary'
                              : 'quiet'
                        }
                        loading={busy === busyFor(action)}
                        disabled={
                          (!!busy && busy !== busyFor(action)) ||
                          (action === 'merge' && (decision.mergeDisabled || !diff))
                        }
                        title={
                          action === 'merge' && decision.mergeDisabled
                            ? 'Merge waits until the required checks pass'
                            : undefined
                        }
                        onClick={() => run(action)}
                      >
                        {label(action)}
                      </Action>
                    ))}
                  </span>
                )}
              </div>
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
                  className={
                    pull.checkCount && pull.checksPassed === pull.checkCount ? 'dl-ok' : ''
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
              // The checks open where their runs and logs are: the project's pipeline run.
              href={checksRun ? `${pipelines}?run=${encodeURIComponent(checksRun.id)}` : undefined}
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
            {pull.release && (
              <Item
                lead={<Icon name="deploy" />}
                title={`Released to ${coordinator}`}
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
          {!diff && !changes.error && <Skeleton rows={5} />}
          {diff && (
            <>
              <Commits
                commits={diff.commits}
                count={diff.commitCount}
                target={pull.targetBranch}
                project={project}
              />
              <Files
                files={files}
                added={added}
                removed={removed}
                project={project}
                head={diff.headCommit}
                before={diff.mergeBase || diff.baseCommit}
              />
            </>
          )}
        </>
      )}
    </>
  );
}

function DecisionIcon({ kind }: { kind: PullDecision['kind'] }) {
  if (kind === 'merging' || kind === 'checks-running')
    return <Icon name="running" className="dl-run dl-spin" />;
  if (kind === 'ready') return <Icon name="check" className="dl-ok" />;
  if (kind === 'checks-failed' || kind === 'merge-failed')
    return <Icon name="failed" className="dl-fail" />;
  if (kind === 'closed') return <Icon name="close" />;
  return <Icon name="attention" className={kind === 'conflicts' ? 'dl-attn' : ''} />;
}

/** Names in a sentence, each a link to the same place. */
function Linked({ names, href }: { names: string[]; href?: string }) {
  return (
    <>
      {names.map((name, index) => (
        <Fragment key={index}>
          {index === 0 ? '' : index === names.length - 1 ? ' and ' : ', '}
          {href ? (
            <a className="dl-link" href={href}>
              {name}
            </a>
          ) : (
            name
          )}
        </Fragment>
      ))}
    </>
  );
}

function Commits({
  commits,
  count,
  target,
  project,
}: {
  commits: PullCommit[];
  count: number;
  target: string;
  project: string;
}) {
  const { repositoryTime } = useProjectFormatting();
  const [open, setOpen] = useState(false);
  const folded = foldMerges(commits);
  const row = (commit: PullCommit) => (
    <Item
      key={commit.oid}
      lead={<span className="dl-avatar v2-pr-avatar">{commit.author.slice(0, 1)}</span>}
      title={commit.subject}
      description={`${commit.author} · ${repositoryTime(commit.date)}`}
      end={<span className="dl-mono">{commit.oid.slice(0, 7)}</span>}
      href={`${projectPath(project)}/code?ref=${commit.oid}&history=true`}
      chevron={false}
    />
  );
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">
        Commits <span className="v2-pr-number">{count}</span>
      </h2>
      <Group>
        {folded.commits.map(row)}
        {folded.merges.length > 0 && (
          <>
            <button
              type="button"
              className="dl-item v2-pr-fold v2-pr-quiet"
              aria-expanded={open}
              aria-controls="pull-merges"
              onClick={() => setOpen(!open)}
            >
              <span className="v2-pr-lead">
                <Icon name={open ? 'down' : 'chevron'} size={14} />
              </span>
              <span className="dl-t">
                <span>{mergesLabel(folded.merges.length, target)}</span>
              </span>
              <span className="dl-c">latest {repositoryTime(folded.latest)}</span>
            </button>
            <div id="pull-merges" hidden={!open} className="v2-pr-merges">
              {open && folded.merges.map(row)}
            </div>
          </>
        )}
      </Group>
      {count > commits.length && (
        <p className="dl-meta">
          Showing {commits.length} of {count} commits.
        </p>
      )}
    </section>
  );
}

function Files({
  files,
  added,
  removed,
  project,
  head,
  before,
}: {
  files: PatchFile[];
  added: number;
  removed: number;
  project: string;
  head?: string;
  before?: string;
}) {
  const [query, setQuery] = useState('');
  const [opened, setOpened] = useState<Record<string, boolean>>({});
  const [more, setMore] = useState(false);
  const matching = filterFiles(files, query);
  const filtering = !!query.trim();
  const shown = more || filtering ? matching : matching.slice(0, FILES_SHOWN);
  const hidden = matching.length - shown.length;
  // Folded rows share a group; an opened file breaks it, as the boards draw.
  const runs: (PatchFile[] | PatchFile)[] = [];
  for (const file of shown) {
    if (opened[file.file]) runs.push(file);
    else if (Array.isArray(runs.at(-1))) (runs.at(-1) as PatchFile[]).push(file);
    else runs.push([file]);
  }
  // Opening or folding a file swaps its row for the opened file, so focus follows it there.
  const section = useRef<HTMLElement>(null);
  const focus = useRef<string | null>(null);
  useEffect(() => {
    if (!focus.current) return;
    section.current
      ?.querySelector<HTMLElement>(`[data-pull-file="${CSS.escape(focus.current)}"]`)
      ?.focus();
    focus.current = null;
  });
  const toggle = (file: string) => {
    focus.current = file;
    setOpened((value) => ({ ...value, [file]: !value[file] }));
  };
  const showMore = hidden > 0 && (
    <button
      type="button"
      className="dl-item v2-pr-fold v2-pr-show-more"
      onClick={() => setMore(true)}
    >
      <span className="dl-t">
        <span>Show {hidden} more</span>
      </span>
    </button>
  );
  return (
    <section className="dl-section" ref={section}>
      <div className="v2-pr-files-head">
        <h2 className="dl-section-title">
          Files changed{' '}
          <span className="v2-pr-number">
            {filesCount(matching.length, files.length, filtering)}
          </span>{' '}
          <span className="dl-add v2-pr-total">+{added}</span>{' '}
          <span className="dl-del v2-pr-total">−{removed}</span>
        </h2>
        {files.length > FILES_SHOWN && (
          <label className="dl-field v2-pr-filter">
            <Icon name="search" size={14} />
            <input
              type="text"
              placeholder="Filter files"
              aria-label="Filter files"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && query) setQuery('');
              }}
            />
          </label>
        )}
      </div>
      {filtering && !matching.length && (
        <p className="dl-meta">No changed file’s path contains “{query.trim()}”.</p>
      )}
      <div className="v2-pr-diffs">
        {runs.map((run, index) =>
          Array.isArray(run) ? (
            <div className="dl-group" key={run[0].file}>
              {run.map((file) => (
                <FileRow key={file.file} file={file} onToggle={() => toggle(file.file)} />
              ))}
              {index === runs.length - 1 && showMore}
            </div>
          ) : (
            <OpenFile
              key={run.file}
              file={run}
              project={project}
              commit={fileChange(run) === 'deleted' ? before : head}
              onToggle={() => toggle(run.file)}
            />
          ),
        )}
        {!Array.isArray(runs.at(-1)) && showMore && <div className="dl-group">{showMore}</div>}
      </div>
    </section>
  );
}

function imageLine(file: PatchFile) {
  return `Image · ${fileChange(file)}`;
}

function FileRow({ file, onToggle }: { file: PatchFile; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="dl-item v2-pr-fold v2-pr-file"
      aria-expanded={false}
      data-pull-file={file.file}
      onClick={onToggle}
    >
      <span className="v2-pr-lead">
        <Icon name="chevron" size={14} />
      </span>
      <span className="dl-t">
        <span className="v2-pr-path">{file.file}</span>
      </span>
      <span className="dl-c">
        {isImage(file.file) ? (
          imageLine(file)
        ) : (
          <>
            <span className="dl-add">+{file.added}</span>{' '}
            <span className="dl-del">−{file.removed}</span>
          </>
        )}
      </span>
    </button>
  );
}

function OpenFile({
  file,
  project,
  commit,
  onToggle,
}: {
  file: PatchFile;
  project: string;
  commit?: string;
  onToggle: () => void;
}) {
  const toggle = (
    <button
      type="button"
      className="v2-pr-diff-toggle"
      aria-expanded
      data-pull-file={file.file}
      onClick={onToggle}
    >
      <Icon name="down" size={14} />
      <span className="dl-sr">Fold {file.file}</span>
    </button>
  );
  if (isImage(file.file))
    return (
      <div className="v2-pr-diff-open">
        {toggle}
        <ImageFile file={file} project={project} commit={commit} />
      </div>
    );
  return (
    <div className="v2-pr-diff-open">
      {toggle}
      <Diff file={file.file} lines={file.lines} />
    </div>
  );
}

type Blob = { size?: number; image?: { mimeType: string; data: string }; omitted?: string };

/** An opened image: its preview from the version that has it, and its pixel and file size. */
function ImageFile({
  file,
  project,
  commit,
}: {
  file: PatchFile;
  project: string;
  commit?: string;
}) {
  const blob = useData<Blob>(
    commit
      ? `/api/projects/${encodeURIComponent(project)}/repository/blob?ref=${encodeURIComponent(commit)}&path=${encodeURIComponent(file.file)}`
      : undefined,
    { immutable: true },
  );
  const [pixels, setPixels] = useState('');
  const name = file.file.split('/').at(-1);
  return (
    <section className="dl-source">
      <div className="dl-source-head">
        <span className="dl-strong v2-pr-path">{file.file}</span>
        <span className="dl-end v2-pr-image-meta">
          <span>{imageLine(file)}</span>
          {blob.data?.size !== undefined && (
            <span>{[pixels, fileSize(blob.data.size)].filter(Boolean).join(' · ')}</span>
          )}
        </span>
      </div>
      <div className="v2-pr-preview">
        {blob.error ? (
          <p className="dl-meta">{blob.error}</p>
        ) : !blob.data ? (
          <Skeleton rows={3} label={`Loading ${name}`} />
        ) : blob.data.image ? (
          <img
            className="v2-pr-shot"
            src={`data:${blob.data.image.mimeType};base64,${blob.data.image.data}`}
            alt={name}
            onLoad={(event) =>
              setPixels(
                `${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`,
              )
            }
          />
        ) : (
          <p className="dl-meta">{blob.data.omitted || 'This image cannot be previewed.'}</p>
        )}
      </div>
    </section>
  );
}
