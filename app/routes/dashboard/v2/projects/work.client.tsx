'use client';
import { useState, type ReactNode } from 'react';
import { useRouter } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Dialog,
  Empty,
  Field,
  Group,
  Icon,
  Item,
  Seg,
  Skeleton,
} from '@/components/ui';
import type {
  ProjectWork,
  WorkRow,
  WorkStage,
} from '../../../../../server/features/repositories/project-work.ts';
import { request } from './data';
import { useProjectFormatting } from './formatting.ts';
import { projectPath, projectSegment } from './routing';
import { workSections } from './work.ts';
import { newTaskIn } from '../start/chosen-project';

const lead: Record<WorkStage, ReactNode> = {
  'needs-you': <Icon name="attention" className="dl-attn" label="Needs you" />,
  running: <Icon name="running" className="dl-run" label="Running" />,
  'up-next': (
    <span className="v2-work-idea">
      <Icon name="bulb" />
    </span>
  ),
  found: (
    <span className="v2-work-idea">
      <Icon name="bulb" />
    </span>
  ),
  shipped: <Icon name="check" className="dl-ok" label="Shipped" />,
};

/** A project's work by stage: what needs you, what runs, what is written down, what agents found. */
export function ProjectWorkTab({
  projectId,
  work,
  error,
  refresh,
}: {
  projectId: string;
  work: ProjectWork | undefined;
  error: string;
  refresh: () => void;
}) {
  const { pullElapsed } = useProjectFormatting();
  const { navigate } = useRouter();
  const [show, setShow] = useState<'open' | 'shipped'>('open');
  const [idea, setIdea] = useState(false);
  const [opened, setOpened] = useState<WorkRow>();
  const api = `/api/projects/${projectSegment(projectId)}/issues`;
  const href = (row: WorkRow) =>
    row.link.kind === 'task'
      ? `/dashboard/tasks/${encodeURIComponent(row.link.id)}`
      : row.link.kind === 'pull'
        ? `${projectPath(projectId)}/pulls/${projectSegment(row.link.id)}`
        : undefined;
  const item = (row: WorkRow) => (
    <Item
      key={row.id}
      lead={lead[row.stage]}
      title={row.title}
      description={row.meta.join(' · ')}
      end={pullElapsed(row.at)}
      href={href(row)}
      // An idea opens in place to start, accept or dismiss it; a closed one has nothing to do.
      onClick={
        row.link.kind === 'issue' && row.stage !== 'shipped' ? () => setOpened(row) : undefined
      }
    />
  );
  const sections = work ? workSections(work) : [];
  return (
    <>
      <div className="v2-work-bar">
        <Seg
          label="Work"
          value={show}
          onChange={(value) => setShow(value as 'open' | 'shipped')}
          options={[
            { value: 'open', label: `Open${work ? ` ${work.counts.open}` : ''}` },
            { value: 'shipped', label: `Shipped${work ? ` ${work.counts.shipped}` : ''}` },
          ]}
        />
        <span className="dl-end">
          <Action onClick={() => setIdea(true)}>New idea</Action>
        </span>
      </div>
      {error && <Banner title={error} action={<Action onClick={refresh}>Retry</Action>} />}
      {!work && !error && <Skeleton rows={4} />}
      {work && show === 'open' && !work.rows.length && (
        <Empty
          title={work.shipped.length ? 'Nothing open' : 'No work yet'}
          actions={
            <a className="dl-btn secondary" href={newTaskIn(projectId)}>
              New task
            </a>
          }
        >
          {work.shipped.length
            ? 'Everything here has shipped. Write down an idea or start a task.'
            : 'Write down an idea for later, or start a task and it shows here while it runs.'}
        </Empty>
      )}
      {work &&
        show === 'open' &&
        sections.map((section) => (
          <section key={section.stage} className="dl-section v2-work-section">
            <h2 className="dl-section-title">{section.title}</h2>
            {section.sub && <p className="dl-section-sub">{section.sub}</p>}
            <Group>{section.rows.map(item)}</Group>
          </section>
        ))}
      {work && show === 'shipped' && (
        <section className="dl-section v2-work-section">
          {work.shipped.length ? (
            <Group>{work.shipped.map(item)}</Group>
          ) : (
            <Empty title="Nothing shipped yet">
              Merged pull requests and closed ideas show here.
            </Empty>
          )}
        </section>
      )}
      <NewIdea
        open={idea}
        api={api}
        onClose={() => setIdea(false)}
        onCreated={() => {
          setIdea(false);
          refresh();
        }}
      />
      {opened?.issue && (
        <IdeaDialog
          row={opened}
          api={`${api}/${encodeURIComponent(opened.issue.id)}`}
          onClose={() => setOpened(undefined)}
          onDone={(taskId) => {
            setOpened(undefined);
            refresh();
            if (taskId) void navigate(`/dashboard/tasks/${encodeURIComponent(taskId)}`);
          }}
        />
      )}
    </>
  );
}

function NewIdea({
  open,
  api,
  onClose,
  onCreated,
}: {
  open: boolean;
  api: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    setBusy(true);
    setError('');
    try {
      await request(api, {
        method: 'POST',
        body: JSON.stringify({ operationId: crypto.randomUUID(), title, body }),
      });
      setTitle('');
      setBody('');
      onCreated();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title="New idea"
      actions={
        <>
          <Action disabled={busy} onClick={onClose}>
            Cancel
          </Action>
          <Action
            variant="primary"
            loading={busy}
            disabled={!title.trim()}
            onClick={() => void create()}
          >
            Add to Up next
          </Action>
        </>
      }
    >
      <div className="v2-project-form">
        <Field label="Title" value={title} onChange={(event) => setTitle(event.target.value)} />
        <Field label="Description" value={body} onChange={(event) => setBody(event.target.value)} />
        {error && <Banner title={error} />}
      </div>
    </Dialog>
  );
}

/** An idea opened in place: start it, or, for one an agent found, add it to Up next or dismiss it. */
function IdeaDialog({
  row,
  api,
  onClose,
  onDone,
}: {
  row: WorkRow;
  api: string;
  onClose: () => void;
  onDone: (taskId?: string) => void;
}) {
  const [busy, setBusy] = useState<'' | 'start' | 'accept' | 'close'>('');
  const [error, setError] = useState('');
  const found = row.stage === 'found';
  async function act(action: 'task' | 'accept' | 'close') {
    setBusy(action === 'task' ? 'start' : action);
    setError('');
    try {
      const result = await request<{ task?: { id: string } }>(`${api}/${action}`, {
        method: 'POST',
        body: JSON.stringify({ operationId: crypto.randomUUID(), revision: row.issue!.revision }),
      });
      onDone(action === 'task' ? result.task?.id : undefined);
    } catch (failure) {
      setError((failure as Error).message);
      setBusy('');
    }
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title={row.title}
      actions={
        found ? (
          <>
            <Action
              disabled={!!busy && busy !== 'close'}
              loading={busy === 'close'}
              onClick={() => void act('close')}
            >
              Dismiss
            </Action>
            <Action
              variant="primary"
              disabled={!!busy && busy !== 'accept'}
              loading={busy === 'accept'}
              onClick={() => void act('accept')}
            >
              Add to Up next
            </Action>
          </>
        ) : (
          <>
            <Action disabled={!!busy} onClick={onClose}>
              Cancel
            </Action>
            <Action variant="primary" loading={busy === 'start'} onClick={() => void act('task')}>
              Start
            </Action>
          </>
        )
      }
    >
      <p className="dl-meta">{row.meta.join(' · ')}</p>
      {row.issue!.body.trim() && <p className="v2-work-body">{row.issue!.body}</p>}
      {error && <Banner title={error} />}
    </Dialog>
  );
}
