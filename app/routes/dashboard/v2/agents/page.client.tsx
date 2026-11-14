'use client';
import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-flight-router/client';
import { Action, Banner, Dialog, Empty, Field, Skeleton } from '@/components/ui';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import { SettingsList, SettingsRow } from '@/components/ui/v2/SettingsList';
import type { AgentConfiguration as Agent, Project } from '../../../../../shared/v2/contracts';
import { avatarFromId, randomAgentAvatar } from '../../../../../shared/v2/agents';
import { AgentHead, request } from './shared';
import { AgentHistory } from './history';
import { AgentConversation } from './conversation';
import { AgentIdentity } from './identity';
import { LooksAfterList } from './item';
import { AgentRules } from '../settings/approvals';
import { useDataSeed, readSeeded } from '../data/seeds';
import { useResource } from '../data/hooks';
import './style.css';
export default function Agents() {
  const { pathname } = useLocation();
  const agentId = decodeURIComponent(pathname.split('/')[3] || '');
  return !agentId ? (
    <AgentsLanding />
  ) : agentId === 'new' ? (
    <NewAgent />
  ) : (
    <ExistingAgent
      key={agentId}
      agentId={agentId}
      tune={pathname.endsWith('/tune')}
      historyItemId={
        pathname.endsWith('/history') ? decodeURIComponent(pathname.split('/')[5] || '') : undefined
      }
    />
  );
}
function AgentsLanding() {
  const { data, loading, error } = useResource<{ agents: Agent[] }>('/api/agents');
  useEffect(() => {
    if (data?.agents[0])
      window.location.replace(`/dashboard/agents/${encodeURIComponent(data.agents[0].id)}`);
  }, [data]);
  return (
    <>
      <AgentHead title="Agents" />
      {loading ? (
        <Skeleton rows={4} />
      ) : error ? (
        <Banner kind="danger" title="Agents are unavailable. Try again." />
      ) : !data?.agents.length ? (
        <div className="dl-agent-empty">
          <Empty
            title="Make an agent to talk to"
            actions={
              <a className="dl-btn primary" href="/dashboard/agents/new">
                New agent
              </a>
            }
          >
            Give it a name. Teach it what to do in the chat.
          </Empty>
        </div>
      ) : null}
    </>
  );
}
function NewAgent() {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState(randomAgentAvatar);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function create() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError('');
    try {
      const { agent } = await request('/agents', 'POST', { name: name.trim(), avatar });
      window.location.assign(`/dashboard/agents/${encodeURIComponent(agent.id)}`);
    } catch (failure: any) {
      setError(failure.message);
      setBusy(false);
    }
  }
  return (
    <>
      <AgentHead title="Agents" />
      <Dialog
        open
        title="New agent"
        className="dl-agent-new-dialog"
        onClose={() => {
          if (!busy) window.location.assign('/dashboard');
        }}
        loading={busy}
        actions={
          <Action
            variant="primary"
            disabled={!name.trim()}
            loading={busy}
            onClick={() => void create()}
          >
            Create
          </Action>
        }
      >
        <div className="dl-agent-fields">
          {error && <Banner kind="danger" title={error} />}
          <AgentIdentity creating value={avatar} onChange={setAvatar} />
          <Field
            data-dialog-focus
            label="Name"
            placeholder="Name your agent"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </Dialog>
    </>
  );
}
function ExistingAgent({
  agentId,
  tune,
  historyItemId,
}: {
  agentId: string;
  tune: boolean;
  historyItemId?: string;
}) {
  const seed = useDataSeed();
  const [agent, setAgent] = useState<Agent | null>(
    () =>
      (seed?.data['/api/agents'] as { agents: Agent[] } | undefined)?.agents.find(
        (a) => a.id === agentId,
      ) ?? null,
  );
  const [projects, setProjects] = useState<Project[]>(
    () => (seed?.data['/api/projects'] as { projects: Project[] } | undefined)?.projects ?? [],
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const jobField = useRef<HTMLTextAreaElement>(null);
  const path = `/agents/${encodeURIComponent(agentId)}`;
  useEffect(() => {
    let active = true;
    const load = (initial = false) =>
      (initial ? readSeeded(seed, '/api/agents', () => request('/agents')) : request('/agents'))
        .then((v) => {
          if (active) setAgent(v.agents.find((a: Agent) => a.id === agentId) ?? null);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void load(true);
    readSeeded(seed, '/api/projects', () => request('/projects'))
      .then((v) => {
        if (active) setProjects(v.projects);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    // A settings draft is kept intact while chat rebuilds from server events.
    const changed = () => {
      if (!tune) void load();
    };
    window.addEventListener('deploy:agents-changed', changed);
    return () => {
      active = false;
      window.removeEventListener('deploy:agents-changed', changed);
    };
  }, [agentId, tune, seed]);
  async function save() {
    if (!agent) return;
    setBusy(true);
    setError('');
    try {
      const result = await request(path, 'PATCH', {
        name: agent.name,
        avatar: agent.avatar,
        job: agent.job,
        computers: agent.computers,
        projectId: agent.projectId || '',
      });
      setAgent(result.agent);
      window.location.assign(`/dashboard${path}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setError('');
    try {
      await request(path, 'DELETE');
      window.location.assign('/dashboard');
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
    <>
      <AgentHead
        title={
          tune ? (
            'Agent details'
          ) : (
            <span className="dl-agent-header">
              {historyItemId && (
                <a
                  className="dl-icon-btn"
                  href={`/dashboard${path}`}
                  aria-label="Back to conversation"
                >
                  ‹
                </a>
              )}
              <a className="dl-agent-identity" href={`/dashboard${path}/tune`}>
                {agent && <AgentAvatar avatar={agent.avatar} id={agent.id} />}
                <span className="dl-agent-name">{agent?.name || 'Agent'}</span>⌄
              </a>
            </span>
          )
        }
        actions={
          tune ? (
            <>
              <a className="dl-btn quiet" href={`/dashboard${path}`}>
                Cancel
              </a>
              <Action
                variant="primary"
                loading={busy}
                disabled={!agent?.name.trim()}
                onClick={() => void save()}
              >
                Save
              </Action>
            </>
          ) : undefined
        }
      />
      {error && <Banner kind="danger" title={error} />}
      {!agent ? (
        <Skeleton rows={4} label="Loading agent" />
      ) : historyItemId ? (
        <AgentHistory agent={agent} itemId={historyItemId} onChanged={setAgent} />
      ) : tune ? (
        <div className="dl-scroll">
          <div className="dl-agent-form">
            <AgentIdentity
              value={agent.avatar ?? avatarFromId(agent.id)}
              onChange={(avatar) => setAgent({ ...agent, avatar })}
            />
            <Field
              label="Name"
              value={agent.name}
              maxLength={80}
              onChange={(e) => setAgent({ ...agent, name: e.target.value })}
            />
            <section className="dl-section">
              <h2 className="dl-section-title">What it does</h2>
              <p className="dl-meta">
                {agent.job
                  ? 'Learned from your messages'
                  : 'Tell it what you want it to do in chat'}{' '}
                ·{' '}
                <button type="button" className="dl-link" onClick={() => jobField.current?.focus()}>
                  Edit
                </button>
              </p>
              <textarea
                ref={jobField}
                aria-label="What it does"
                className="dl-agent-instructions"
                value={agent.job}
                maxLength={12000}
                onChange={(e) => setAgent({ ...agent, job: e.target.value })}
              />

              <p className="dl-meta">
                Changes apply to future replies and work. Existing messages stay as they were.
              </p>
            </section>
            <SettingsList
              title={<h2 className="dl-section-title">What it's learned</h2>}
              note="Lessons come from your answers. It asks before keeping anything it worked out itself."
            >
              <SettingsRow title="Nothing learned yet. It learns from how you answer its work." />
            </SettingsList>
            <LooksAfterList
              agent={agent}
              onSaved={(updated) => setAgent({ ...agent, looksAfter: updated.looksAfter })}
            />
            <SettingsList title={<h2 className="dl-section-title">What it may use</h2>}>
              <SettingsRow
                title="Project"
                subtitle="Choose one project, or no project"
                value={
                  <select
                    aria-label="Works in"
                    className="dl-agent-select"
                    value={agent.projectId || ''}
                    onChange={(e) => setAgent({ ...agent, projectId: e.target.value || undefined })}
                  >
                    <option value="">No project</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                }
              />
              <SettingsRow
                title="Computers"
                subtitle="Where its tasks can run"
                value={
                  <input
                    aria-label="Computers"
                    className="dl-agent-select"
                    value={agent.computers.join(', ')}
                    onChange={(e) =>
                      setAgent({
                        ...agent,
                        computers: e.target.value
                          .split(',')
                          .map((v) => v.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                }
              />
            </SettingsList>
            <AgentRules agent={agent} />
            <SettingsList
              title={`Delete ${agent.name}`}
              note="Its Looks after items and approval rules go with it. Tasks it already started stay in your task list."
            >
              <SettingsRow
                title={`Delete ${agent.name}`}
                value={
                  <Action variant="danger" onClick={() => setRemoving(true)}>
                    Delete…
                  </Action>
                }
              />
            </SettingsList>
          </div>
        </div>
      ) : (
        <AgentConversation agent={agent} onChanged={setAgent} />
      )}
      <Dialog
        open={removing}
        title={`Delete ${agent?.name || 'this agent'}?`}
        onClose={() => setRemoving(false)}
        actions={
          <>
            <Action onClick={() => setRemoving(false)}>Cancel</Action>
            <Action variant="danger" loading={busy} onClick={() => void remove()}>
              Delete
            </Action>
          </>
        }
      >
        <p>
          Its Looks after items and approval rules go with it. Tasks it already started stay in your
          task list.
        </p>
      </Dialog>
    </>
  );
}
