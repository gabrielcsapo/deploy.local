'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, Dialog, Field, Glyph, Group, Icon, Skeleton } from '@/components/ui';
import type {
  Agent,
  ApprovalAction,
  ApprovalRule,
  Project,
} from '../../../../../shared/v2/contracts';
import { request } from '../agents/shared';

const actions: { id: ApprovalAction; name: string; description?: string }[] = [
  { id: 'merge', name: 'Merge a pull request' },
  { id: 'ship', name: 'Release to a computer', description: 'Only you can start a release' },
  { id: 'restart', name: 'Restart an app' },
  { id: 'rollback', name: 'Roll back a release' },
  { id: 'install', name: 'Install an app' },
  { id: 'change-secrets', name: 'Change secrets' },
  { id: 'use-screen', name: 'Use the screen' },
  { id: 'spend', name: 'Spend money' },
];
const labels = { ask: 'Ask me', allow: 'Allowed', never: 'Never' };
export function Approvals() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [rules, setRules] = useState<ApprovalRule[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState<ApprovalRule | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  async function load() {
    setError('');
    try {
      const [a, r, p] = await Promise.all([
        request('/agents'),
        request('/approvals'),
        request('/projects'),
      ]);
      setAgents(a.agents);
      setRules(r.rules);
      setProjects(p.projects);
      setLoaded(true);
    } catch (failure: any) {
      setError(failure.message);
    }
  }
  useEffect(() => {
    void load();
  }, []);
  function open(agent: string, action: ApprovalAction, existing?: ApprovalRule) {
    setSaved(false);
    setEditingId(existing?.id || null);
    setEdit(existing || { id: crypto.randomUUID(), agent, action, mode: 'ask' });
  }
  async function save(mode = edit?.mode) {
    if (!edit || !mode) return;
    setBusy(true);
    setError('');
    const updated = {
      ...edit,
      mode,
      ...(edit.limit?.trim() ? { limit: edit.limit.trim() } : { limit: undefined }),
    };
    const next = rules.filter((rule) => rule.id !== editingId);
    if (
      next.some(
        (rule) =>
          rule.agent === updated.agent &&
          rule.action === updated.action &&
          rule.projectId === updated.projectId,
      )
    ) {
      setError('A rule already exists for this project. Edit that rule instead.');
      setBusy(false);
      return;
    }
    try {
      const result = await request('/approvals', 'PUT', { rules: [...next, updated] });
      setRules(result.rules);
      setEdit(null);
      setSaved(true);
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  const control = (agent: Agent, action: (typeof actions)[number]) => {
    const rule = rules.find(
      (item) => item.agent === agent.id && item.action === action.id && !item.projectId,
    );
    const scoped = rules.filter(
      (item) => item.agent === agent.id && item.action === action.id && item.projectId,
    ).length;
    return (
      <button
        className="dl-approval-rule"
        type="button"
        onClick={() => open(agent.id, action.id, rule)}
        aria-label={`Edit ${agent.name}: ${action.name}`}
      >
        <span className={`dl-tag ${rule?.mode === 'allow' ? 'dl-agent-allowed' : ''}`}>
          {labels[rule?.mode || 'ask']}
        </span>
        {scoped > 0 && (
          <span className="dl-meta">
            {scoped} project {scoped === 1 ? 'rule' : 'rules'}
          </span>
        )}
      </button>
    );
  };
  const name = agents.find((agent) => agent.id === edit?.agent)?.name || 'Agent';
  return (
    <>
      {error && !edit && (
        <Banner
          kind="danger"
          title={error}
          action={<Action onClick={() => void load()}>Retry</Action>}
        />
      )}
      {saved && <Banner kind="neutral" title="Rule saved" />}
      {!loaded ? (
        !error && <Skeleton rows={6} label="Loading approvals" />
      ) : (
        <>
          <section className="dl-section">
            <h1 className="dl-section-title">What agents may do</h1>
            <p className="dl-section-sub">
              Each agent starts by asking. Trust grows one action at a time, and every answer is in{' '}
              <a className="dl-link" href="/dashboard/inbox?tab=answered">
                Answered
              </a>
              .
            </p>
            <div className="dl-group dl-matrix-table">
              <table className="dl-table">
                <caption className="dl-sr">Agent approvals</caption>
                <thead>
                  <tr>
                    <th scope="col">Action</th>
                    {agents.map((agent) => (
                      <th scope="col" key={agent.id}>
                        <Glyph kind={agent.id === 'warden' ? 'warden' : ''}>{agent.name[0]}</Glyph>{' '}
                        {agent.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {actions.map((action) => (
                    <tr key={action.id}>
                      <th scope="row">
                        <span>{action.name}</span>
                        {action.description && (
                          <span className="dl-meta dl-agent-rule-description">
                            {action.description}
                          </span>
                        )}
                      </th>
                      {agents.map((agent) => (
                        <td key={agent.id}>{control(agent, action)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="dl-matrix-stack">
              {agents.map((agent) => (
                <Group
                  key={agent.id}
                  title={
                    <>
                      <Glyph kind={agent.id === 'warden' ? 'warden' : ''}>{agent.name[0]}</Glyph>{' '}
                      {agent.name}
                    </>
                  }
                >
                  {actions.map((action) => (
                    <div className="dl-item" key={action.id}>
                      <span className="dl-t">
                        <span>{action.name}</span>
                        {action.description && <span>{action.description}</span>}
                      </span>
                      {control(agent, action)}
                    </div>
                  ))}
                </Group>
              ))}
            </div>
          </section>
          <section className="dl-section">
            <h2 className="dl-section-title">Project rules and limits</h2>
            <p className="dl-section-sub">
              A project rule replaces the general rule for that project. Limits that cannot be
              checked automatically still require your answer.
            </p>
            <Group>
              {rules
                .filter((rule) => rule.projectId || rule.limit)
                .map((rule) => (
                  <button
                    key={rule.id}
                    type="button"
                    className="dl-item dl-agent-rule-row"
                    onClick={() => open(rule.agent, rule.action, rule)}
                  >
                    <span className="dl-t">
                      <span>
                        {agents.find((agent) => agent.id === rule.agent)?.name || rule.agent} ·{' '}
                        {actions.find((action) => action.id === rule.action)?.name}
                      </span>
                      <span>
                        {projects.find((project) => project.id === rule.projectId)?.name ||
                          rule.projectId ||
                          'All projects'}
                        {rule.limit ? ` · ${rule.limit}` : ''}
                      </span>
                    </span>
                    <span>{labels[rule.mode]}</span>
                    <Icon name="chevron" />
                  </button>
                ))}
              <div className="dl-item">
                <span className="dl-t">Scope one action to a project</span>
                <Action
                  variant="quiet"
                  onClick={() => {
                    if (agents[0]) open(agents[0].id, 'rollback');
                  }}
                >
                  Add rule
                </Action>
              </div>
            </Group>
          </section>
          <section className="dl-section">
            <h2 className="dl-section-title">Always yours</h2>
            <Group>
              <div className="dl-item">
                <span className="dl-t">
                  <span>Start a release</span>
                  <span>Press Ship… or merge a pull request yourself.</span>
                </span>
                <span className="dl-tag">Only you</span>
              </div>
            </Group>
          </section>
          <section className="dl-section">
            <h2 className="dl-section-title">Agents</h2>
            <Group
              title="Your agents"
              end={
                <a className="dl-btn quiet" href="/dashboard/agents/new">
                  New agent
                </a>
              }
            >
              {agents.map((agent) => (
                <div className="dl-item" key={agent.id}>
                  <Glyph kind={agent.id === 'warden' ? 'warden' : ''}>{agent.name[0]}</Glyph>
                  <span className="dl-t">
                    <a href={`/dashboard/agents/${encodeURIComponent(agent.id)}`}>{agent.name}</a>
                    <span>{agent.job.split('\n')[0]}</span>
                  </span>
                  <a
                    className="dl-btn quiet"
                    href={`/dashboard/agents/${encodeURIComponent(agent.id)}/tune`}
                  >
                    Tune
                  </a>
                </div>
              ))}
            </Group>
          </section>
        </>
      )}
      <Dialog
        open={!!edit}
        onClose={() => {
          if (!busy) setEdit(null);
        }}
        title={`${name} may ${actions.find((action) => action.id === edit?.action)?.name.toLowerCase() || 'act'}`}
        loading={busy}
        actions={
          <>
            <Action variant="quiet" onClick={() => void save('ask')}>
              Back to asking
            </Action>
            <Action onClick={() => setEdit(null)}>Cancel</Action>
            <Action variant="primary" onClick={() => void save()}>
              Save rule
            </Action>
          </>
        }
      >
        {edit && (
          <div className="dl-rule-fields">
            {error && <Banner kind="danger" title={error} />}
            <label className="dl-field-label">
              Agent
              <select
                className="dl-rule-select"
                value={edit.agent}
                onChange={(event) => setEdit({ ...edit, agent: event.target.value })}
              >
                {agents.map((agent) => (
                  <option key={agent.id} value={agent.id}>
                    {agent.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="dl-field-label">
              May
              <select
                className="dl-rule-select"
                value={edit.action}
                onChange={(event) =>
                  setEdit({
                    ...edit,
                    action: event.target.value as ApprovalAction,
                    mode:
                      event.target.value === 'ship' && edit.mode === 'allow' ? 'ask' : edit.mode,
                  })
                }
              >
                {actions.map((action) => (
                  <option key={action.id} value={action.id}>
                    {action.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="dl-field-label">
              Permission
              <select
                className="dl-rule-select"
                value={edit.mode}
                onChange={(event) =>
                  setEdit({ ...edit, mode: event.target.value as ApprovalRule['mode'] })
                }
              >
                <option value="ask">Ask me</option>
                <option value="allow" disabled={edit.action === 'ship'}>
                  Allowed
                </option>
                <option value="never">Never</option>
              </select>
            </label>
            <label className="dl-field-label">
              Which project
              <select
                className="dl-rule-select"
                value={edit.projectId || ''}
                onChange={(event) =>
                  setEdit({ ...edit, projectId: event.target.value || undefined })
                }
              >
                <option value="">All projects</option>
                {edit.projectId && !projects.some((project) => project.id === edit.projectId) && (
                  <option value={edit.projectId}>{edit.projectId}</option>
                )}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
            <Field
              label="At most"
              value={edit.limit || ''}
              placeholder="No limit"
              maxLength={2000}
              onChange={(event) => setEdit({ ...edit, limit: event.target.value })}
            />
            <p className="dl-meta">
              A limit that cannot be checked automatically keeps this action on Ask me.
            </p>
          </div>
        )}
      </Dialog>
    </>
  );
}
