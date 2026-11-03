'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, Dialog, Field } from '@/components/ui';
import { SettingsList, SettingsRow } from '@/components/ui/v2/SettingsList';
import type {
  AgentConfiguration,
  LooksAfterItem,
  Project,
} from '../../../../../shared/v2/contracts';
import { itemSummary, weekDays } from '../../../../../shared/v2/agents';
import { request } from './shared';
import { useCoordinatorName, useResource } from '../data/hooks';
export function LooksAfterEditor({
  agent,
  item,
  onClose,
  onSaved,
}: {
  agent: AgentConfiguration;
  item: LooksAfterItem;
  onClose: () => void;
  onSaved: (agent: AgentConfiguration) => void;
}) {
  const [draft, setDraft] = useState(item);
  const [projects, setProjects] = useState<Project[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const coordinator = useCoordinatorName();
  useEffect(() => {
    Promise.all([request('/projects'), request('/agents')])
      .then(([v, a]) => {
        setProjects(v.projects);
        if (!agent.looksAfter?.some((i) => i.id === item.id))
          setDraft((d) => ({ ...d, when: { ...d.when, timezone: a.timezone } }));
      })
      .catch((e) => setError(e.message));
  }, [agent.looksAfter, item.id]);
  const when = (values: Partial<LooksAfterItem['when']>) =>
    setDraft({ ...draft, when: { ...draft.when, ...values } });
  async function confirm() {
    setBusy(true);
    setError('');
    try {
      // Read first so edits made elsewhere are retained.
      const current: AgentConfiguration = (await request('/agents')).agents.find(
        (a: AgentConfiguration) => a.id === agent.id,
      );
      const looksAfter = [...(current.looksAfter ?? []).filter((i) => i.id !== draft.id), draft];
      await request(`/agents/${encodeURIComponent(agent.id)}`, 'PATCH', { looksAfter });
      const result = await request(
        `/agents/${encodeURIComponent(agent.id)}/items/${encodeURIComponent(draft.id)}/confirm`,
        'POST',
      );
      onSaved(result.agent);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onClose={() => {
        if (!busy) onClose();
      }}
      title="Looks after"
      loading={busy}
      actions={
        <>
          <Action
            variant="primary"
            disabled={
              !draft.what.trim() ||
              (typeof draft.where !== 'string' && !draft.where.projects.length)
            }
            loading={busy}
            onClick={() => void confirm()}
          >
            Confirm item
          </Action>
          <Action onClick={onClose}>Cancel</Action>
        </>
      }
    >
      <div className="dl-agent-fields">
        {error && <Banner kind="danger" title={error} />}
        <label>
          What
          <textarea
            data-dialog-focus
            className="dl-agent-instructions"
            value={draft.what}
            onChange={(e) => setDraft({ ...draft, what: e.target.value })}
            maxLength={12000}
          />
        </label>
        <label>
          Where
          <select
            className="dl-agent-select"
            value={typeof draft.where === 'string' ? draft.where : 'chosen'}
            onChange={(e) =>
              setDraft({
                ...draft,
                where:
                  e.target.value === 'chosen'
                    ? { projects: [] }
                    : (e.target.value as 'all-active' | 'active-and-maintained'),
              })
            }
          >
            <option value="all-active">All Active</option>
            <option value="active-and-maintained">All Active and Maintained</option>
            <option value="chosen">Chosen projects</option>
          </select>
        </label>
        {typeof draft.where !== 'string' && (
          <SettingsList
            title="Projects"
            note={`${agent.projectId ? `Only ${projects.find((p) => p.id === agent.projectId)?.name ?? agent.projectId} is within this agent’s access. ` : ''}Choosing a project never grants access.`}
          >
            {projects.map((p) => (
              <SettingsRow
                key={p.id}
                title={p.name}
                subtitle={
                  !agent.projectId || agent.projectId === p.id ? 'Access granted' : 'Needs access'
                }
                value={
                  <input
                    aria-label={p.name}
                    type="checkbox"
                    disabled={!!agent.projectId && agent.projectId !== p.id}
                    checked={typeof draft.where !== 'string' && draft.where.projects.includes(p.id)}
                    onChange={(e) => {
                      const ids = typeof draft.where === 'string' ? [] : draft.where.projects;
                      setDraft({
                        ...draft,
                        where: {
                          projects: e.target.checked
                            ? [...ids, p.id]
                            : ids.filter((id) => id !== p.id),
                        },
                      });
                    }}
                  />
                }
              />
            ))}
          </SettingsList>
        )}
        <label>
          When
          <select
            className="dl-agent-select"
            value={draft.when.every}
            onChange={(e) =>
              when({
                every: e.target.value as LooksAfterItem['when']['every'],
                day: draft.when.day ?? 1,
              })
            }
          >
            <option value="week">Every week</option>
            <option value="day">Every day</option>
            <option value="change">On each change</option>
          </select>
        </label>
        {draft.when.every === 'week' && (
          <label>
            Day
            <select
              className="dl-agent-select"
              value={draft.when.day ?? 1}
              onChange={(e) => when({ day: Number(e.target.value) })}
            >
              {weekDays.map((day, i) => (
                <option value={i} key={day}>
                  {day}
                </option>
              ))}
            </select>
          </label>
        )}
        {draft.when.every !== 'change' && (
          <Field
            label="Time"
            type="time"
            value={draft.when.time}
            onChange={(e) => when({ time: e.target.value })}
          />
        )}
        <p className="dl-meta">On {coordinator}’s clock</p>
        <label>
          Brings
          <select
            className="dl-agent-select"
            value={draft.brings}
            onChange={(e) =>
              setDraft({ ...draft, brings: e.target.value as LooksAfterItem['brings'] })
            }
          >
            {['pull-request', 'design-review', 'question', 'message'].map((v) => (
              <option key={v} value={v}>
                A {v.replaceAll('-', ' ')}
              </option>
            ))}
          </select>
        </label>
        <p className="dl-meta">
          Proposed from your message. Starts after you confirm. Uses this agent’s access and
          approval rules.
        </p>
      </div>
    </Dialog>
  );
}
export function newLooksAfter(): LooksAfterItem {
  return {
    id: crypto.randomUUID(),
    what: '',
    where: 'all-active',
    when: {
      every: 'week',
      day: 1,
      time: '08:40',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
    brings: 'message',
  };
}
export function LooksAfterList({
  agent,
  onSaved,
}: {
  agent: AgentConfiguration;
  onSaved: (agent: AgentConfiguration) => void;
}) {
  const projects = useResource<{ projects: Project[] }>('/api/v2/projects').data?.projects ?? [];
  const [edit, setEdit] = useState<LooksAfterItem | null>(null);
  return (
    <>
      <section className="dl-section">
        <div className="dl-agent-section-head">
          <div>
            <h2 className="dl-section-title">Looks after</h2>
            <p className="dl-section-sub">What · where · when · brings</p>
          </div>

          <Action onClick={() => setEdit(newLooksAfter())}>Add</Action>
        </div>
        {!agent.looksAfter?.length && (
          <div className="dl-group">
            <SettingsRow
              title="Nothing to look after yet"
              subtitle="Add something in chat"
              href={`/dashboard/agents/${encodeURIComponent(agent.id)}`}
            />
          </div>
        )}
        {agent.looksAfter?.map((item) => (
          <div key={item.id}>
            <div className="dl-group">
              <SettingsRow
                title={item.what.split('\n')[0]}
                subtitle={itemSummary(item, projects)}
                value={<span className="dl-link">Edit</span>}
                onClick={() => setEdit(item)}
              />
            </div>
            <p className="dl-meta dl-agent-item-history">
              <a className="dl-link" href={itemHistoryPath(agent.id, item.id)}>
                History
              </a>{' '}
              ·{' '}
              <span>
                {item.confirmedAt
                  ? `Confirmed · Next ${item.when.every === 'change' ? 'change' : item.nextAt ? new Date(item.nextAt).toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: item.when.timezone }).replace(',', '') : 'scheduled check'}`
                  : 'Starts after you confirm'}
              </span>
            </p>
          </div>
        ))}
      </section>
      {edit && (
        <LooksAfterEditor
          agent={agent}
          item={edit}
          onClose={() => setEdit(null)}
          onSaved={onSaved}
        />
      )}
    </>
  );
}

export function itemHistoryPath(agentId: string, itemId: string) {
  return `/dashboard/agents/${encodeURIComponent(agentId)}/items/${encodeURIComponent(itemId)}/history`;
}
