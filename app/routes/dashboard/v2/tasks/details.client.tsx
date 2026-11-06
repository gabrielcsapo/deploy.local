'use client';
import { useState } from 'react';
import { Action, Diff, Icon, IconButton, Seg, Term } from '@/components/ui';
import { formatTime } from '../data/time';
import { parsePatch } from './api';
import { checkDuration, checkPassed, checkResult, checkSummary, fileTree } from './presentation';
import type { TaskCheck, TaskCheckpoint, TaskView } from './types';

export function TaskPanel({
  view,
  base,
  onClose,
}: {
  view: TaskView;
  base: string;
  onClose: () => void;
}) {
  const pull = view.pulls.at(-1);
  const branch = pull?.sourceBranch || view.task.branch;
  const projectDetail = [view.project?.kind, view.project?.address].filter(Boolean).join(' · ');
  const started = [view.task.startedFrom && `From ${view.task.startedFrom}`, view.task.startedModel]
    .filter(Boolean)
    .join(' · ');
  return (
    <aside className="dl-task-panel" aria-label="This task">
      <div className="dl-panel-head">
        This task
        <span className="dl-end">
          <IconButton icon="close" label="Close task panel" onClick={onClose} />
        </span>
      </div>
      <div className="dl-panel-body">
        {view.project && (
          <>
            <div className="dl-panel-label">Project</div>
            <a
              className="dl-panel-item"
              href={`/dashboard/projects/${encodeURIComponent(view.project.id)}`}
            >
              <Icon name="folder" />
              <span className="dl-t">
                <span>{view.project.name}</span>
                {projectDetail && <span>{projectDetail}</span>}
              </span>
            </a>
          </>
        )}
        {pull && (
          <>
            <div className="dl-panel-label">Pull request</div>
            <a className="dl-panel-item" href={`${base}/changes`}>
              <Icon name="merge" />
              <span className="dl-t">
                <span>
                  #{pull.number} into {pull.targetBranch}
                </span>
                {pull.createdAt && <span>Opened {formatTime(pull.createdAt)}</span>}
              </span>
            </a>
          </>
        )}
        {branch && (
          <>
            <div className="dl-panel-label">Branch</div>
            <div className="dl-panel-item">
              <Icon name="branch" />
              <span className="dl-t">
                <span className="dl-mono">{branch}</span>
                {view.comparison?.ahead !== undefined && (
                  <span>
                    {view.comparison.ahead} {view.comparison.ahead === 1 ? 'commit' : 'commits'}{' '}
                    ahead of {pull?.targetBranch || 'main'}
                  </span>
                )}
              </span>
            </div>
          </>
        )}
        {view.packages?.map((pkg) => (
          <div key={pkg.name}>
            <div className="dl-panel-label">Package</div>
            <div className="dl-panel-item">
              <Icon name="package" />
              <span className="dl-t">
                <span>
                  {pkg.name} {pkg.version}
                </span>
                <span>
                  The pipeline publishes it after merge
                  {pkg.previousVersion ? ` · now ${pkg.previousVersion}` : ''}
                </span>
              </span>
            </div>
          </div>
        ))}
        {view.computer && (
          <>
            <div className="dl-panel-label">Computer</div>
            <div className="dl-panel-item">
              <Icon name="computer" />
              <span className="dl-t">
                <span>
                  {view.computerId ? (
                    <a href={`/dashboard/computers/${encodeURIComponent(view.computerId)}`}>
                      {view.computer}
                    </a>
                  ) : (
                    view.computer
                  )}
                </span>
              </span>
            </div>
          </>
        )}
        {(view.task.createdAt || view.task.startedBy || started) && (
          <>
            <div className="dl-panel-label">Started</div>
            <div className="dl-panel-item">
              <Icon name="clock" />
              <span className="dl-t">
                <span>
                  {[
                    view.task.startedBy && `By ${view.task.startedBy}`,
                    view.task.createdAt && formatTime(view.task.createdAt),
                  ]
                    .filter(Boolean)
                    .join(', ')}
                </span>
                {started && <span>{started}</span>}
              </span>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function CheckRows({ checks }: { checks: TaskCheck[] }) {
  const [selected, setSelected] = useState<string>();
  const log = checks.find((check) => check.id === selected);
  return (
    <>
      <div className="dl-group">
        {checks.map((check) => (
          <div className="dl-item dl-task-check" key={check.id}>
            <Icon
              name={
                checkPassed(check)
                  ? 'check'
                  : check.status === 'running'
                    ? 'running'
                    : check.status === 'failed'
                      ? 'close'
                      : 'clock'
              }
              className={
                checkPassed(check)
                  ? 'dl-ok'
                  : check.status === 'failed'
                    ? 'dl-fail'
                    : check.status === 'running'
                      ? 'dl-run dl-spin'
                      : ''
              }
            />
            <span className="dl-t">
              <span>{check.name || check.label || check.command || 'Recorded check'}</span>
              {check.command && <span className="dl-mono">{check.command}</span>}
            </span>
            <span className="dl-c dl-task-check-result">{checkResult(check)}</span>
            <span className="dl-c dl-task-check-duration">{checkDuration(check)}</span>
            <Action
              variant="quiet"
              className="dl-task-log"
              aria-expanded={selected === check.id}
              onClick={() => setSelected(selected === check.id ? undefined : check.id)}
            >
              Log
              <Icon name="chevron" size={14} />
            </Action>
          </div>
        ))}
      </div>
      {log && <Term>{log.output || log.evidence || log.error || 'No output recorded.'}</Term>}
    </>
  );
}
export function TaskChecks({
  view,
  checks,
  checkpoint,
  earlier,
}: {
  view: TaskView;
  checks: TaskCheck[];
  checkpoint?: TaskCheckpoint;
  earlier: TaskCheckpoint[];
}) {
  const [expanded, setExpanded] = useState<string>();
  const settings =
    view.project && `/dashboard/projects/${encodeURIComponent(view.project.id)}/settings`;
  const unavailable =
    'This coordinator cannot rerun a checkpoint’s recorded commands as a check suite yet.';
  return (
    <>
      {checks.length ? (
        <section className="dl-section">
          <div className="dl-task-check-head">
            <h2 className="dl-section-title">
              {checkpoint ? `Checkpoint ${checkpoint.number}` : 'Latest checks'}
            </h2>
            <span className="dl-meta">
              Latest · {checkSummary(checks)}
              {checkpoint && ` · ${formatTime(checkpoint.at)}`}
            </span>
            <span className="dl-end">
              <Action disabled title={unavailable}>
                Run again
              </Action>
            </span>
          </div>
          <CheckRows checks={checks} />
        </section>
      ) : (
        <div className="dl-group">
          <div className="dl-empty">
            <span className="dl-glyph">
              <Icon name="check" />
            </span>
            <h3>No checks yet</h3>
            <p>
              {view.computer ? `Checks recorded on ${view.computer}` : 'Recorded checks'} show up
              here, one row per check.
            </p>
            <div className="dl-actions">
              <Action disabled title={unavailable}>
                Run checks now
              </Action>
            </div>
          </div>
        </div>
      )}
      {!!earlier.length && (
        <section className="dl-section">
          <div className="dl-task-check-head">
            <h2 className="dl-section-title">Earlier checkpoints</h2>
          </div>
          <div className="dl-group">
            {earlier.map((item) => (
              <div key={item.id}>
                <button
                  type="button"
                  className="dl-item dl-task-checkpoint"
                  aria-expanded={expanded === item.id}
                  onClick={() => setExpanded(expanded === item.id ? undefined : item.id)}
                >
                  <Icon
                    name={
                      item.checks.length && item.checks.every(checkPassed)
                        ? 'check'
                        : item.checks.some((check) => check.status === 'failed')
                          ? 'close'
                          : 'clock'
                    }
                    className={item.checks.length && item.checks.every(checkPassed) ? 'dl-ok' : ''}
                  />
                  <span className="dl-t">
                    <span>Checkpoint {item.number}</span>
                    <span>{checkSummary(item.checks)}</span>
                  </span>
                  <span className="dl-c">{formatTime(item.at)}</span>
                  <Icon name="chevron" size={14} />
                </button>
                {expanded === item.id && !!item.checks.length && <CheckRows checks={item.checks} />}
              </div>
            ))}
          </div>
        </section>
      )}
      {settings && (
        <p className="dl-meta dl-task-check-foot">
          {view.project!.name}'s checks are set in{' '}
          <a className="dl-link" href={settings}>
            project settings
          </a>
          .
        </p>
      )}
    </>
  );
}

export function TaskFiles({ files }: { files: ReturnType<typeof parsePatch> }) {
  const [mode, setMode] = useState('unified');
  const [selected, setSelected] = useState<string>();
  return (
    <>
      <div className="dl-task-files-bar">
        <span>
          {files.length} {files.length === 1 ? 'file' : 'files'} changed
        </span>
        <span className="dl-meta">
          <span className="dl-add">+{files.reduce((sum, file) => sum + file.added, 0)}</span>{' '}
          <span className="dl-del">−{files.reduce((sum, file) => sum + file.removed, 0)}</span>
        </span>
        <span className="dl-end">
          <Seg
            label="Diff layout"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'unified', label: 'Unified' },
              { value: 'split', label: 'Split' },
            ]}
          />
        </span>
      </div>
      <div className="dl-task-file-layout">
        <nav className="dl-task-files" aria-label="Changed files">
          {fileTree(files.map((file) => file.file)).map((row) => {
            const file = files.find((entry) => entry.file === row.path);
            const content = (
              <>
                <Icon name={row.folder ? 'folder' : 'file'} size={14} />
                <span className="dl-t">{row.label}</span>
                {file && (
                  <span className="dl-end">
                    <span className="dl-add">{file.added ? `+${file.added}` : ''}</span>{' '}
                    <span className="dl-del">{file.removed ? `−${file.removed}` : ''}</span>
                  </span>
                )}
              </>
            );
            const style = { paddingLeft: 8 + row.depth * 16 };
            return row.folder ? (
              <div className="dl-task-file" key={row.path} style={style}>
                {content}
              </div>
            ) : (
              <a
                className={`dl-task-file ${(selected || files[0]?.file) === row.path ? 'on' : ''}`}
                aria-current={(selected || files[0]?.file) === row.path ? 'true' : undefined}
                href={`#${encodeURIComponent(row.path)}`}
                key={row.path}
                style={style}
                onClick={() => setSelected(row.path)}
              >
                {content}
              </a>
            );
          })}
        </nav>
        <div className="dl-task-diffs">
          {files.map((file) => (
            <div
              id={encodeURIComponent(file.file)}
              key={file.file}
              className={mode === 'split' ? 'dl-task-split' : undefined}
            >
              {mode === 'unified' ? (
                <Diff file={file.file} lines={file.lines} />
              ) : (
                <section className="dl-source">
                  <div className="dl-source-head">
                    <Icon name="file" />
                    <span>{file.file}</span>
                    <span className="dl-end">
                      <span className="dl-add">+{file.added}</span>{' '}
                      <span className="dl-del">−{file.removed}</span>
                    </span>
                  </div>
                  <div
                    className="dl-task-split-lines"
                    role="region"
                    aria-label={`Split changes to ${file.file}`}
                    tabIndex={0}
                  >
                    {file.lines.map((line, index) => (
                      <div className={`dl-task-split-line ${line.kind || ''}`} key={index}>
                        <span className="dl-n">{line.old}</span>
                        <code>{line.kind !== 'add' ? line.text : ''}</code>
                        <span className="dl-n">{line.new}</span>
                        <code>{line.kind !== 'del' ? line.text : ''}</code>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
