import { list, save } from '../workspace/store.ts';
import { fail } from '../kernel/errors.ts';

export type NotificationPreferences = {
  decisions: boolean;
  failingApps: boolean;
  quietHours: boolean;
  timeZone: string;
};
export type AgentControl = { paused: boolean; mutedUntil: string | null };
export function notificationPreferences(owner: string): NotificationPreferences {
  const row = list('v2-notification-preferences', owner)[0];
  return {
    decisions: row?.decisions ?? true,
    failingApps: row?.failingApps ?? true,
    quietHours: row?.quietHours ?? false,
    timeZone: row?.timeZone ?? 'UTC',
  };
}
export function putNotificationPreferences(owner: string, body: any) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Object.keys(body).length ||
    Object.keys(body).some(
      (key) => !['decisions', 'failingApps', 'quietHours', 'timeZone'].includes(key),
    )
  )
    fail('Invalid notification preferences');
  for (const key of ['decisions', 'failingApps', 'quietHours'])
    if (body[key] !== undefined && typeof body[key] !== 'boolean') fail(`${key} must be a boolean`);
  if (body.timeZone !== undefined) {
    if (typeof body.timeZone !== 'string' || body.timeZone.length > 100) fail('Invalid time zone');
    try {
      new Intl.DateTimeFormat('en', { timeZone: body.timeZone }).format();
    } catch {
      fail('Invalid time zone');
    }
  }
  const preferences = { ...notificationPreferences(owner), ...body };
  save('v2-notification-preferences', owner, { id: 'preferences', ...preferences });
  return preferences;
}
export function agentControl(owner: string, agent: string): AgentControl {
  const row = list('v2-agent-control', owner).find((entry) => entry.id === agent);
  return { paused: row?.paused ?? false, mutedUntil: row?.mutedUntil ?? null };
}
export function putAgentControl(owner: string, agent: string, body: any, time = Date.now()) {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    !Object.keys(body).length ||
    Object.keys(body).some((key) => !['paused', 'muteMinutes'].includes(key))
  )
    fail('Invalid agent controls');
  if (body.paused !== undefined && typeof body.paused !== 'boolean')
    fail('paused must be a boolean');
  if (body.muteMinutes !== undefined && ![0, 60].includes(body.muteMinutes))
    fail('muteMinutes must be 0 or 60');
  const state = {
    ...agentControl(owner, agent),
    ...(body.paused !== undefined ? { paused: body.paused } : {}),
    ...(body.muteMinutes !== undefined
      ? { mutedUntil: body.muteMinutes ? new Date(time + 3600_000).toISOString() : null }
      : {}),
  };
  save('v2-agent-control', owner, { id: agent, ...state });
  return state;
}
export function shouldNotify(
  owner: string,
  kind: 'decision' | 'health',
  agent?: string,
  rollback = false,
  time = Date.now(),
) {
  const preferences = notificationPreferences(owner);
  if (kind === 'decision' ? !preferences.decisions : !preferences.failingApps) return false;
  if (agent && Date.parse(agentControl(owner, agent).mutedUntil || '') > time) return false;
  if (preferences.quietHours && !rollback) {
    const hour = Number(
      new Intl.DateTimeFormat('en', {
        timeZone: preferences.timeZone,
        hour: 'numeric',
        hourCycle: 'h23',
      }).format(time),
    );
    if (hour >= 22 || hour < 7) return false;
  }
  return true;
}
