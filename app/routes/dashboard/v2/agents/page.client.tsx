'use client';
import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import { Action, Banner, Dialog, Field, Glyph, Group, Icon, Skeleton } from '@/components/ui';
import type { Agent } from '../../../../../shared/v2/contracts';
import { AgentHead, Elsewhere, request } from './shared';
import { AgentConversation } from './conversation';
import './style.css';

type Draft = Pick<Agent, 'name' | 'job' | 'computers'>;
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
function Computers({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  const [input, setInput] = useState(value.join(', '));
  return (
    <Field
      label="Computers"
      placeholder="Computer IDs, separated by commas; leave empty for all"
      value={input}
      onChange={(event) => {
        setInput(event.target.value);
        onChange(
          event.target.value
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}

function NewAgent() {
  const [job, setJob] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function draftIt() {
    setBusy(true);
    setError('');
    try {
      setDraft((await request('/agents/draft', 'POST', { job })).draft);
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
  const examples: Record<string, string> = {
    'Keep dependencies current':
      'Watch for dependency updates. Explain what changed and propose a task. Ask before changing anything.',
    'Watch disk space':
      'Watch disk space on SER and bazzite. Tell me a week before a disk fills, say which app is growing, and suggest what to clean up. Never delete anything yourself.',
    'Write release notes':
      'After each release, draft short release notes from the changes. Ask before publishing.',
    'Triage new issues':
      'Review new issues, find duplicates, and propose the next step. Ask before changing an issue.',
  };
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
            <li aria-current={!draft ? 'step' : undefined}>Describe the job</li>
            <li aria-current={draft ? 'step' : undefined}>Review the draft</li>
            <li>Start asking</li>
          </ol>
          {error && <Banner kind="danger" title={error} />}
          {draft ? (
            <>
              <p className="dl-meta">
                <Glyph>S</Glyph> Scout drafted this from your description · edit anything
              </p>
              <Field
                label="Name"
                value={draft.name}
                maxLength={80}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
              <Instructions
                name={draft.name}
                value={draft.job}
                onChange={(value) => setDraft({ ...draft, job: value })}
              />
              <Computers
                value={draft.computers}
                onChange={(value) => setDraft({ ...draft, computers: value })}
              />
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
              <section>
                <h1 className="dl-title">What should this agent keep doing?</h1>
                <p className="dl-section-sub">
                  An agent is a standing job: it works on a schedule or when something happens, and
                  asks you before it acts. Scout drafts the rest from this.
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
              <div className="dl-agent-examples">
                <span className="dl-meta">Or start from</span>
                {Object.entries(examples).map(([name, value]) => (
                  <Action key={name} variant="quiet" disabled={busy} onClick={() => setJob(value)}>
                    <Icon name="bulb" size={14} />
                    {name}
                  </Action>
                ))}
              </div>
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
            <Glyph kind={agentId === 'warden' ? 'warden' : ''}>{agent?.name[0] || '·'}</Glyph>{' '}
            {tune ? 'Tune ' : ''}
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
            <Computers
              value={agent.computers}
              onChange={(computers) => setAgent({ ...agent, computers })}
            />
            <Elsewhere name={agent.name} />
          </div>
        </div>
      ) : (
        <AgentConversation agent={agent} />
      )}
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
