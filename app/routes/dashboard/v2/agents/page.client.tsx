'use client';
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import {
  Action,
  Banner,
  Dialog,
  Field,
  Glyph,
  Group,
  Icon,
  Setting,
  Switch,
  Skeleton,
} from '@/components/ui';
import type { AgentConfiguration as Agent, Project } from '../../../../../shared/v2/contracts';
import { AgentHead, Elsewhere, request } from './shared';
import { AgentConversation } from './conversation';
import './style.css';

type Draft = Omit<Agent, 'id' | 'createdBy'>;
// Starting points for the plus button. Each works in the background every morning and asks
// before it acts; everything stays editable on the next step.
const templates: { name: string; summary: string; job: string }[] = [
  {
    name: 'Dependency watcher',
    summary: 'Checks for updates and advisories, proposes safe ones',
    job: "Check the project's dependencies for updates and security advisories. Explain what changed and which updates are safe. Open a pull request for safe patch updates; ask before anything bigger.",
  },
  {
    name: 'Pull request reviewer',
    summary: 'Reviews open pull requests for bugs and missing tests',
    job: 'Review open pull requests in the project. Point out bugs, missing tests and risky changes, with a short summary for each. Never merge.',
  },
  {
    name: 'Check fixer',
    summary: 'Finds why checks or releases failed and proposes a fix',
    job: "Look at the project's failing checks and recent failed releases. Find the cause and propose the smallest fix as a pull request. Ask before changing anything outside the failure.",
  },
  {
    name: 'Issue triager',
    summary: 'Sorts new issues, finds duplicates, suggests next steps',
    job: 'Review new issues, find duplicates, and propose the next step for each. Ask before changing an issue.',
  },
  {
    name: 'Release notes writer',
    summary: 'Drafts notes for what merged since its last run',
    job: 'Summarize what was merged and released since your last run as short release notes. Ask before publishing them anywhere.',
  },
];
function fromTemplate(template: (typeof templates)[number]): Draft {
  return {
    name: template.name,
    job: template.job,
    computers: [],
    apps: [],
    schedule: { enabled: true, time: '08:00' },
    triggers: { mention: true, disk: false },
  };
}
export default function Agents() {
  const { pathname } = useLocation();
  const agentId = decodeURIComponent(pathname.split('/')[3] || '');
  return agentId === 'new' ? (
    <NewAgent />
  ) : (
    <ExistingAgent key={agentId} agentId={agentId} tune={pathname.endsWith('/tune')} />
  );
}
function Instructions({
  value,
  onChange,
  name,
}: {
  value: string;
  onChange: (value: string) => void;
  name: string;
}) {
  return (
    <section className="dl-section">
      <label className="dl-section-title" htmlFor="agent-instructions">
        Instructions
      </label>
      <p className="dl-section-sub">
        What {name} is for and how it works. This is most of its tuning.
      </p>
      <textarea
        id="agent-instructions"
        className="dl-agent-instructions"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        maxLength={12000}
        required
      />
    </section>
  );
}
function WorkingPreferences({
  value,
  onChange,
}: {
  value: Draft;
  onChange: (value: Draft) => void;
}) {
  const schedule = value.schedule || { enabled: false, time: '08:00' };
  const triggers = value.triggers || { mention: true, disk: false };
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    request('/projects')
      .then(({ projects }: { projects: Project[] }) => setProjects(projects))
      .catch(() => setProjects([]));
  }, []);
  const ids = (input: string) =>
    input
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
  return (
    <>
      <section className="dl-section">
        <h2 className="dl-section-title">When {value.name} works</h2>
        <Group>
          <Setting
            label="Every morning"
            description={
              <input
                className="dl-matrix-select"
                aria-label="Morning time"
                type="time"
                value={schedule.time}
                onChange={(event) =>
                  onChange({ ...value, schedule: { ...schedule, time: event.target.value } })
                }
              />
            }
          >
            <Switch
              label="Every morning"
              checked={schedule.enabled}
              onChange={(enabled) => onChange({ ...value, schedule: { ...schedule, enabled } })}
            />
          </Setting>
          <Setting label="A disk passes 80%" description="On any covered computer">
            <Switch
              label="A disk passes 80%"
              checked={triggers.disk}
              onChange={(disk) => onChange({ ...value, triggers: { ...triggers, disk } })}
            />
          </Setting>
          <Setting label={`@${value.name} mentions`} description="In a conversation">
            <Switch
              label="Mentions"
              checked={triggers.mention}
              onChange={(mention) => onChange({ ...value, triggers: { ...triggers, mention } })}
            />
          </Setting>
        </Group>
        <p className="dl-meta">
          Every morning at {schedule.time} on SER’s clock, {value.name} starts a task in the
          background. It asks you first in Waiting on you unless Start a task is Allowed in
          Approvals. Disk and mention triggers are saved for later.
        </p>
      </section>
      <section className="dl-section">
        <h2 className="dl-section-title">Covers</h2>
        <Group>
          <Setting
            label="Works in"
            description="The project whose code each run checks out; none gives it an empty folder"
          >
            <select
              className="dl-matrix-select"
              aria-label="Works in"
              value={value.projectId || ''}
              onChange={(event) =>
                onChange({ ...value, projectId: event.target.value || undefined })
              }
            >
              <option value="">No project</option>
              {projects?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </Setting>
          <Setting label="Computers" description="Computer IDs, separated by commas">
            <input
              className="dl-matrix-select"
              aria-label="Computers"
              placeholder="All computers"
              defaultValue={value.computers.join(', ')}
              onBlur={(event) => onChange({ ...value, computers: ids(event.target.value) })}
            />
          </Setting>
          <Setting label="Apps" description="App names, separated by commas">
            <input
              className="dl-matrix-select"
              aria-label="Apps"
              placeholder="All apps"
              defaultValue={value.apps?.join(', ') || ''}
              onBlur={(event) => onChange({ ...value, apps: ids(event.target.value) })}
            />
          </Setting>
        </Group>
      </section>
    </>
  );
}

function NewAgent() {
  const [job, setJob] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function draftIt() {
    setBusy(true);
    setError('');
    try {
      setDraft((await request('/agents/draft', 'POST', { job })).draft);
      setSource('');
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  async function create() {
    setBusy(true);
    setError('');
    try {
      const { agent } = await request('/agents', 'POST', draft);
      window.location.assign(`/dashboard/agents/${encodeURIComponent(agent.id)}`);
    } catch (failure: any) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return (
    <>
      <AgentHead
        title="New agent"
        actions={
          <a className="dl-icon-btn" aria-label="Close" href="/dashboard">
            <Icon name="close" />
          </a>
        }
      />
      <div className="dl-scroll">
        <div className="dl-agent-form">
          <ol className="dl-agent-progress" aria-label="New agent steps">
            <li aria-current={!draft ? 'step' : undefined}>Pick or describe the job</li>
            <li aria-current={draft ? 'step' : undefined}>Review the draft</li>
            <li>Start asking</li>
          </ol>
          {error && <Banner kind="danger" title={error} />}
          {draft ? (
            <>
              <p className="dl-meta">
                {source ? `From the ${source} template` : 'Drafted from your description'} · edit
                anything
              </p>
              <div className="dl-agent-draft-head">
                <Glyph kind="plain">{draft.name[0]}</Glyph>
                <div className="dl-t">
                  <h1 className="dl-title">{draft.name}</h1>
                  <span className="dl-meta">{draft.job.split('\n')[0]}</span>
                </div>
                <Action variant="quiet" onClick={() => setRenaming(!renaming)}>
                  Rename
                </Action>
              </div>
              {renaming && (
                <Field
                  label="Name"
                  value={draft.name}
                  maxLength={80}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
              )}
              <Instructions
                name={draft.name}
                value={draft.job}
                onChange={(value) => setDraft({ ...draft, job: value })}
              />
              <WorkingPreferences value={draft} onChange={setDraft} />
              <Elsewhere name={draft.name} />
              <div className="dl-agent-actions">
                <Action variant="quiet" disabled={busy} onClick={() => setDraft(null)}>
                  Back
                </Action>
                <Action
                  variant="primary"
                  loading={busy}
                  disabled={!draft.name.trim() || !draft.job.trim()}
                  onClick={() => void create()}
                >
                  Create {draft.name}
                </Action>
              </div>
            </>
          ) : (
            <>
              <section className="dl-section">
                <h1 className="dl-title">What should this agent keep doing?</h1>
                <p className="dl-section-sub">
                  An agent is a standing job. It works in the background on its schedule, as a task
                  you can follow, and asks you before it acts.
                </p>
                <Group title="Start from a template">
                  {templates.map((template) => (
                    <button
                      key={template.name}
                      type="button"
                      className="dl-item dl-agent-template"
                      disabled={busy}
                      onClick={() => {
                        setDraft(fromTemplate(template));
                        setSource(template.name);
                      }}
                    >
                      <Glyph kind="plain">{template.name[0]}</Glyph>
                      <span className="dl-t">
                        <span>{template.name}</span>
                        <span>{template.summary}</span>
                      </span>
                      <Icon name="chevron" />
                    </button>
                  ))}
                </Group>
              </section>
              <section className="dl-section">
                <h2 className="dl-section-title">Or describe your own</h2>
                <p className="dl-section-sub">
                  Your connected model drafts the name and instructions for you to review.
                </p>
                <label className="dl-sr" htmlFor="agent-job">
                  The job
                </label>
                <textarea
                  id="agent-job"
                  className="dl-agent-job"
                  value={job}
                  onChange={(event) => setJob(event.target.value)}
                  maxLength={12000}
                  placeholder="Describe the job…"
                  disabled={busy}
                />
              </section>
              <Banner
                kind="neutral"
                icon="compose"
                title={
                  'Something to do once, like “clean up Immich’s cache”? Start a task instead; it ends when the work is done.'
                }
                action={
                  <a href="/dashboard" className="dl-btn quiet">
                    New task
                  </a>
                }
              />
              <div className="dl-agent-actions">
                <a className="dl-btn quiet" href="/dashboard">
                  Cancel
                </a>
                <Action
                  variant="primary"
                  loading={busy}
                  disabled={!job.trim()}
                  onClick={() => void draftIt()}
                >
                  Draft it
                </Action>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
function ExistingAgent({ agentId, tune }: { agentId: string; tune: boolean }) {
  const [agent, setAgent] = useState<Agent | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [info, setInfo] = useState(false);
  const [menu, setMenu] = useState(false);
  const [removing, setRemoving] = useState(false);
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await request(`/agents/${encodeURIComponent(agentId)}`, 'DELETE');
      window.location.assign('/dashboard');
    } catch (failure: any) {
      setError(failure.message);
      setBusy(false);
    }
  }
  const load = useCallback(
    () =>
      request('/agents')
        .then(({ agents }: { agents: Agent[] }) => {
          const value = agents.find((item) => item.id === agentId);
          if (!value) throw new Error('Agent not found');
          setAgent(value);
          setError('');
        })
        .catch((failure) => setError(failure.message)),
    [agentId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  async function save() {
    if (!agent) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      const { agent: updated } = await request(`/agents/${encodeURIComponent(agentId)}`, 'PATCH', {
        name: agent.name,
        job: agent.job,
        computers: agent.computers,
        apps: agent.apps,
        schedule: agent.schedule,
        triggers: agent.triggers,
        projectId: agent.projectId || '',
      });
      setAgent(updated);
      setSaved(true);
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <AgentHead
        title={
          <>
            <Glyph>{agent?.name[0] || '·'}</Glyph> {tune ? 'Tune ' : ''}
            {agent?.name || 'Agent'}
          </>
        }
        actions={
          tune ? (
            <Action
              variant="primary"
              loading={busy}
              disabled={!agent?.job.trim()}
              onClick={() => void save()}
            >
              Save
            </Action>
          ) : (
            <>
              <Action variant="quiet" aria-label="Agent information" onClick={() => setInfo(true)}>
                <Icon name="panel" />
              </Action>
              <Action
                variant="quiet"
                aria-label="Agent menu"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
              >
                ⋯
              </Action>
            </>
          )
        }
      />
      {menu && (
        <nav className="dl-agent-menu" aria-label="Agent menu">
          <a className="dl-item" href={`/dashboard/agents/${encodeURIComponent(agentId)}/tune`}>
            Tune {agent?.name}
          </a>
          <a className="dl-item" href="/dashboard/settings/approvals">
            Approvals
          </a>
          <a className="dl-item" href="/dashboard/computers/models">
            Models
          </a>
          <Action variant="quiet" onClick={() => setRemoving(true)}>
            Delete {agent?.name}
          </Action>
          <Action variant="quiet" onClick={() => setMenu(false)}>
            Close menu
          </Action>
        </nav>
      )}
      {error && (
        <Banner
          kind="danger"
          title={error}
          action={!agent ? <Action onClick={() => void load()}>Retry</Action> : undefined}
        />
      )}
      {!agent ? (
        !error && <Skeleton rows={4} label="Loading agent" />
      ) : tune ? (
        <div className="dl-scroll">
          <div className="dl-agent-form">
            {saved && <Banner kind="neutral" title="Saved" />}
            <Instructions
              value={agent.job}
              name={agent.name}
              onChange={(job) => {
                setAgent({ ...agent, job });
                setSaved(false);
              }}
            />
            <WorkingPreferences
              value={agent}
              onChange={(value) => setAgent({ ...agent, ...value })}
            />
            <Elsewhere name={agent.name} />
          </div>
        </div>
      ) : (
        <AgentConversation agent={agent} />
      )}
      <Dialog
        open={removing}
        onClose={() => setRemoving(false)}
        title={`Delete ${agent?.name || 'this agent'}?`}
        actions={
          <>
            <Action variant="quiet" disabled={busy} onClick={() => setRemoving(false)}>
              Cancel
            </Action>
            <Action variant="danger" loading={busy} onClick={() => void remove()}>
              Delete
            </Action>
          </>
        }
      >
        <p>
          Its schedule and approval rules go with it. Tasks it already started stay in your task
          list.
        </p>
      </Dialog>
      <Dialog
        open={info}
        onClose={() => setInfo(false)}
        title={agent?.name || 'Agent'}
        actions={
          <a
            className="dl-btn primary"
            href={`/dashboard/agents/${encodeURIComponent(agentId)}/tune`}
          >
            Tune {agent?.name}
          </a>
        }
      >
        <p className="dl-agent-prose">{agent?.job}</p>
        <Group>
          <div className="dl-item">
            <span className="dl-t">Computers</span>
            <span>{agent?.computers.join(', ') || 'All computers'}</span>
          </div>
          <a className="dl-item" href="/dashboard/settings/approvals">
            Approvals
            <Icon name="chevron" />
          </a>
          <a className="dl-item" href="/dashboard/computers/models">
            Models
            <Icon name="chevron" />
          </a>
        </Group>
      </Dialog>
    </>
  );
}
