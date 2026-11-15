import { Cron } from 'croner';
import type {
  AgentConfiguration,
  AgentAvatar,
  LooksAfterItem,
} from '../../../shared/v2/contracts.ts';
import { agentColors, agentGlyphs, avatarFromId } from '../../../shared/v2/agents.ts';
import { save, event, list } from '../../workspace/store.ts';
import { fail } from '../../kernel/errors.ts';

export const coordinatorTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export function validateAvatar(value: any): AgentAvatar {
  if (
    !value ||
    !agentGlyphs.includes(value.glyph) ||
    !agentColors.includes(value.color?.toLowerCase()) ||
    Object.keys(value).some((k) => !['glyph', 'color'].includes(k))
  )
    fail('Invalid avatar');
  return { glyph: value.glyph, color: value.color.toLowerCase() };
}
export function validateItem(value: any): LooksAfterItem {
  if (
    !value ||
    typeof value !== 'object' ||
    Object.keys(value).some(
      (k) => !['id', 'what', 'where', 'when', 'brings', 'confirmedAt', 'nextAt'].includes(k),
    )
  )
    fail('Invalid Looks after item');
  if (
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 200 ||
    typeof value.what !== 'string' ||
    !value.what.trim() ||
    value.what.length > 12000
  )
    fail('An item needs an id and what to do');
  const w = value.where;
  if (
    w !== 'all-active' &&
    w !== 'active-and-maintained' &&
    (!w ||
      typeof w !== 'object' ||
      Object.keys(w).some((k) => k !== 'projects') ||
      !Array.isArray(w.projects) ||
      !w.projects.length ||
      w.projects.length > 100 ||
      w.projects.some((p: any) => typeof p !== 'string' || !p || p.length > 200) ||
      new Set(w.projects).size !== w.projects.length)
  )
    fail('Invalid item projects');
  const t = value.when;
  if (
    !t ||
    Object.keys(t).some((k) => !['every', 'day', 'time', 'timezone'].includes(k)) ||
    !['week', 'day', 'change'].includes(t.every) ||
    typeof t.time !== 'string' ||
    !/^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) ||
    (t.every === 'week' && (!Number.isInteger(t.day) || t.day < 0 || t.day > 6)) ||
    (t.day !== undefined && (!Number.isInteger(t.day) || t.day < 0 || t.day > 6))
  )
    fail('Invalid item schedule');
  try {
    if (typeof t.timezone !== 'string' || !t.timezone) throw new Error();
    new Intl.DateTimeFormat('en', { timeZone: t.timezone }).format();
  } catch {
    fail('Invalid item timezone');
  }
  if (!['pull-request', 'design-review', 'question', 'message'].includes(value.brings))
    fail('Invalid item result');
  if (
    value.confirmedAt !== undefined &&
    (typeof value.confirmedAt !== 'string' || !Number.isFinite(Date.parse(value.confirmedAt)))
  )
    fail('Invalid confirmation');
  return {
    id: value.id,
    what: value.what.trim(),
    where: w,
    when: {
      every: t.every,
      ...(t.every === 'week' ? { day: t.day } : {}),
      time: t.time,
      timezone: t.timezone,
    },
    brings: value.brings,
    ...(value.confirmedAt ? { confirmedAt: value.confirmedAt } : {}),
  };
}
export function nextItemAt(item: LooksAfterItem, after = new Date()): string | undefined {
  if (!item.confirmedAt || item.when.every === 'change') return;
  const [hour, minute] = item.when.time.split(':');
  return new Cron(`${minute} ${hour} * * ${item.when.every === 'week' ? item.when.day : '*'}`, {
    timezone: item.when.timezone,
  })
    .nextRun(after)
    ?.toISOString();
}
export function agentChanged(owner: string, agentId: string) {
  event(owner, '', null, 'agent.changed', { agentId });
}
/** Lazy, persisted migration, shared by reads and the scheduler. No read re-confirms an item. */
export function migrateAgent(owner: string, agent: AgentConfiguration): AgentConfiguration {
  if (agent.avatar && agent.looksAfter) return agent;
  const migrated = {
    ...agent,
    avatar: agent.avatar ?? avatarFromId(agent.id),
    looksAfter:
      agent.looksAfter ??
      (agent.schedule
        ? [
            {
              id: `legacy-${agent.id}`,
              what: agent.job?.split('\n')[0] || 'Run its job',
              where: agent.projectId ? { projects: [agent.projectId] } : ('all-active' as const),
              when: {
                every: 'day' as const,
                time: agent.schedule.time,
                timezone: coordinatorTimezone(),
              },
              brings: 'message' as const,
              ...(agent.schedule.enabled ? { confirmedAt: new Date(0).toISOString() } : {}),
            },
          ]
        : []),
  };
  if (!agent.looksAfter && migrated.looksAfter.length) {
    for (const kind of ['task', 'run'])
      for (const record of list(kind, owner))
        if ((record.agentId === agent.id || record.agent === agent.id) && !record.agentItemId)
          save(kind, owner, { ...record, agentItemId: migrated.looksAfter[0].id });
  }
  save('agent', owner, migrated);
  agentChanged(owner, agent.id);
  return migrated;
}
/** In phase 1 both broad scopes mean every owned project within this agent's access. */
export function itemProjects(owner: string, agent: AgentConfiguration, item: LooksAfterItem) {
  return list('project', owner).filter(
    (p) =>
      (!agent.projectId || p.id === agent.projectId) &&
      (typeof item.where === 'string' || item.where.projects.includes(p.id)),
  );
}
