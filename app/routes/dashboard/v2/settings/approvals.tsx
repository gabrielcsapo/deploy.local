'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, Dialog, Skeleton } from '@/components/ui';
import { AgentAvatar } from '@/components/ui/v2/AgentAvatar';
import { SettingsList, SettingsRow } from '@/components/ui/v2/SettingsList';
import type {
  AgentConfiguration as Agent,
  AgentApprovalRule as Rule,
} from '../../../../../shared/v2/contracts';
import { agentActions } from '../../../../../shared/v2/agents';
import { request } from '../agents/shared';
const labels = { ask: 'Ask', allow: 'Allowed', never: 'Never' };
export function AgentRules({ agent }: { agent: Agent }) {
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    request('/approvals')
      .then((v) => setRules(v.rules))
      .catch((e) => setError(e.message));
  }, []);
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
        title="Approvals"
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
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [selected, setSelected] = useState<Agent | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    Promise.all([request('/agents'), request('/approvals')])
      .then(([a, r]) => {
        setAgents(a.agents);
        setRules(r.rules);
      })
      .catch((e) => setError(e.message));
  }, [selected]);
  function summary(agent: Agent) {
    const entries = agentActions.map(
      (a) =>
        rules.find((r) => r.agent === agent.id && r.action === a.id && !r.projectId)?.mode ?? 'ask',
    );
    if (entries.every((m) => m === 'ask')) return 'Asks before every action';
    return agentActions.map((a, i) => `${a.name}: ${labels[entries[i]]}`).join(' · ');
  }
  return (
    <div className="dl-agent-fields">
      <h1 className="dl-section-title">What agents may do</h1>
      {error && <Banner kind="danger" title={error} />}
      <SettingsList
        title="Agents"
        note="Each agent starts by asking. Trust grows one action at a time."
      >
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
