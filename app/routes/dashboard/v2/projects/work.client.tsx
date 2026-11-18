'use client';
import { useId, useState, type ReactNode } from 'react';
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
      // Shipped reads as a record: no chevrons, so its times line up in one column.
      chevron={row.stage !== 'shipped'}
      // An idea opens in place to start, accept or dismiss it; a closed one has nothing to do.
      onClick={
        row.link.kind === 'issue' && row.stage !== 'shipped' ? () => setOpened(row) : undefined
      }
    />
  );
  const sections = work ? workSections(work) : [];
  // A project with no work at all shows only the empty state, with both ways to begin.
  const blank = !!work && !work.rows.length && !work.shipped.length;
  const begin = (
    <>
      <Action onClick={() => setIdea(true)}>New idea</Action>
      <a className="dl-btn secondary" href={newTaskIn(projectId)}>
        New task
      </a>
    </>
  );
  return (
    <>
      {!blank && (
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
      )}
      {error && <Banner title={error} action={<Action onClick={refresh}>Retry</Action>} />}
      {!work && !error && <Skeleton rows={4} />}
      {blank && (
        <Empty className="v2-work-empty" icon="bulb" title="No work yet" actions={begin}>
          Ideas you write down and tasks you start show here.
        </Empty>
      )}
      {work && !blank && show === 'open' && !work.rows.length && (
        <Empty className="v2-work-empty" icon="bulb" title="Nothing open" actions={begin}>
          Everything here has shipped.
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
      {work && !blank && show === 'shipped' && (
        <section className="dl-section v2-work-section">
          {work.shipped.length ? (
            <Group>{work.shipped.map(item)}</Group>
          ) : (
            <Empty className="v2-work-empty" title="Nothing shipped yet">
              Merged pull requests, finished tasks and closed ideas show here.
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
  const bodyId = useId();
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
        <div>
          <label className="dl-field-label" htmlFor={bodyId}>
            Description
          </label>
          <textarea
            id={bodyId}
            className="dl-textarea v2-work-textarea"
            rows={4}
            value={body}
            onChange={(event) => setBody(event.target.value)}
          />
        </div>
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
  const { seenAgo } = useProjectFormatting();
  // Who wrote or found it, and when: "Written by Gabriel · 3 days ago".
  const when = seenAgo(Date.parse(row.at));
  const byline = [...row.meta, when.charAt(0).toLowerCase() + when.slice(1)].join(' · ');
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
      meta={byline}
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
      {row.issue!.body.trim() && <p className="v2-work-body">{row.issue!.body}</p>}
      {error && <Banner title={error} />}
    </Dialog>
  );
}
