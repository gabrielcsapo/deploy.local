'use client';
import { useEffect, useRef, useState } from 'react';
import { Action, Banner, Dialog, Skeleton } from '@/components/ui';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import { SettingsList, SettingsRow } from '@/components/ui/v2/SettingsList';
import type {
  AgentConfiguration as Agent,
  AgentApprovalRule as Rule,
} from '../../../../../shared/v2/contracts';
import { agentActions } from '../../../../../shared/v2/agents';
import { request } from '../agents/shared';
import { useDataSeed, readSeeded } from '../data/seeds';
const labels = { ask: 'Ask', allow: 'Allowed', never: 'Never' };
export function AgentRules({ agent }: { agent: Agent }) {
  const seed = useDataSeed();
  const [rules, setRules] = useState<Rule[] | null>(
    () => (seed?.data['/api/v2/approvals'] as { rules: Rule[] } | undefined)?.rules ?? null,
  );
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    readSeeded(seed, '/api/v2/approvals', () => request('/approvals'))
      .then((v) => setRules(v.rules))
      .catch((e) => setError(e.message));
  }, [seed]);
  async function change(action: Rule['action'], mode: Rule['mode']) {
    setBusy(true);
    setError('');
    try {
      const current: Rule[] = (await request('/approvals')).rules;
      const old = current.find((r) => r.agent === agent.id && r.action === action && !r.projectId);
      const rule: Rule = { ...(old ?? { id: crypto.randomUUID(), agent: agent.id, action }), mode };
      setRules(
        (
          await request('/approvals', 'PUT', {
            rules: [...current.filter((r) => r.id !== rule.id), rule],
          })
        ).rules,
      );
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {error && <Banner kind="danger" title={error} />}
      <SettingsList
        title={<h2 className="dl-section-title">Approvals</h2>}
        note="Merging and rolling back always show you what changes first."
      >
        {rules ? (
          agentActions.map((action) => (
            <SettingsRow
              key={action.id}
              title={action.name}
              subtitle={action.description}
              value={
                <select
                  className="dl-agent-select"
                  aria-label={action.name}
                  disabled={busy}
                  value={
                    rules.find(
                      (r) => r.agent === agent.id && r.action === action.id && !r.projectId,
                    )?.mode ?? 'ask'
                  }
                  onChange={(e) => void change(action.id, e.target.value as Rule['mode'])}
                >
                  {Object.entries(labels).map(([id, label]) => (
                    <option key={id} value={id}>
                      {label}
                    </option>
                  ))}
                </select>
              }
            />
          ))
        ) : (
          <Skeleton rows={5} />
        )}
      </SettingsList>
    </>
  );
}
export function Approvals() {
  const seed = useDataSeed();
  const first = useRef(true);
  const [agents, setAgents] = useState<Agent[] | null>(
    () => (seed?.data['/api/v2/agents'] as { agents: Agent[] } | undefined)?.agents ?? null,
  );
  const [rules, setRules] = useState<Rule[]>(
    () => (seed?.data['/api/v2/approvals'] as { rules: Rule[] } | undefined)?.rules ?? [],
  );
  const [selected, setSelected] = useState<Agent | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const initial = first.current ? seed : undefined;
    first.current = false;
    Promise.all([
      readSeeded(initial, '/api/v2/agents', () => request('/agents')),
      readSeeded(initial, '/api/v2/approvals', () => request('/approvals')),
    ])
      .then(([a, r]) => {
        setAgents(a.agents);
        setRules(r.rules);
      })
      .catch((e) => setError(e.message));
  }, [selected, seed]);
  function summary(agent: Agent) {
    const entries = agentActions.map(
      (a) =>
        rules.find((r) => r.agent === agent.id && r.action === a.id && !r.projectId)?.mode ?? 'ask',
    );
    if (entries.every((m) => m === 'ask')) return 'Asks before everything';
    if (entries[0] === 'allow' && entries.slice(1).every((m) => m === 'ask'))
      return 'Starts tasks · asks before the rest';
    return 'Custom approvals';
  }
  return (
    <div className="dl-agent-fields">
      <section className="dl-section">
        <h1 className="dl-section-title">What agents may do</h1>
        <p className="dl-section-sub">
          Each agent starts by asking. Trust grows one action at a time, and every answer is in{' '}
          <a className="dl-link" href="/dashboard/inbox?tab=answered">
            Answered
          </a>
          .
        </p>
      </section>
      {error && <Banner kind="danger" title={error} />}
      <SettingsList title={<h2 className="dl-section-title">Agents</h2>}>
        {agents?.map((agent) => (
          <SettingsRow
            key={agent.id}
            lead={<AgentAvatar id={agent.id} avatar={agent.avatar} />}
            title={agent.name}
            subtitle={summary(agent)}
            onClick={() => setSelected(agent)}
          />
        ))}
        {agents?.length === 0 && (
          <SettingsRow title="No agents yet" value="New agent" href="/dashboard/agents/new" />
        )}
        {!agents && <Skeleton rows={5} />}
      </SettingsList>
      <ReleaseChecks onChanged={setRules} />
      <Dialog
        open={!!selected}
        title={selected?.name ?? 'Agent rules'}
        onClose={() => setSelected(null)}
        actions={<Action onClick={() => setSelected(null)}>Done</Action>}
      >
        {selected && <AgentRules key={selected.id} agent={selected} />}
      </Dialog>
    </div>
  );
}

function ReleaseChecks({ onChanged }: { onChanged: (rules: Rule[]) => void }) {
  const seed = useDataSeed();
  const [rules, setRules] = useState<Rule[] | null>(
    () => (seed?.data['/api/v2/approvals'] as { rules: Rule[] } | undefined)?.rules ?? null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    readSeeded(seed, '/api/v2/approvals', () => request('/approvals'))
      .then((v) => setRules(v.rules))
      .catch((e) => setError(e.message));
  }, [seed]);
  const current = rules?.find(
    (rule) => rule.agent === 'warden' && rule.action === 'rollback' && !rule.projectId,
  );
  async function change(mode: Rule['mode']) {
    setBusy(true);
    setError('');
    try {
      const latest: Rule[] = (await request('/approvals')).rules;
      const old = latest.find(
        (rule) => rule.agent === 'warden' && rule.action === 'rollback' && !rule.projectId,
      );
      const rule: Rule = {
        ...(old ?? { id: crypto.randomUUID(), agent: 'warden', action: 'rollback' }),
        mode,
      };
      const result = await request('/approvals', 'PUT', {
        rules: [...latest.filter((entry) => entry.id !== rule.id), rule],
      });
      setRules(result.rules);
      onChanged(result.rules);
    } catch (failure: any) {
      setError(failure.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="dl-section">
      <h2 className="dl-section-title">After a failed release</h2>
      {error && <Banner kind="danger" title={error} />}
      <div className="dl-group">
        <SettingsRow
          title="Roll back a release"
          subtitle="When health checks fail after a release"
          value={
            <select
              className="dl-agent-select"
              aria-label="Roll back a release"
              disabled={busy || !rules}
              value={current?.mode ?? 'ask'}
              onChange={(e) => void change(e.target.value as Rule['mode'])}
            >
              <option value="ask">Ask me</option>
              <option value="allow">Allowed</option>
              <option value="never">Never</option>
            </select>
          }
        />
      </div>
      <p className="dl-list-note">
        deploy.local checks each release’s health. When a release fails, it can put the previous one
        back.
      </p>
    </section>
  );
}
