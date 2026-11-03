import type { AgentAvatar, LooksAfterItem } from './contracts.ts';

export const agentColors = [
  '#af61f2',
  '#76a7ff',
  '#75c675',
  '#e8b130',
  '#ff4d6f',
  '#525fa3',
  '#2fb5a3',
  '#ffaa64',
  '#e66bb8',
  '#8c8c8c',
] as const;
export const agentGlyphs = Array.from(
  { length: 35 },
  (_, i) => `variant${String(i + 1).padStart(2, '0')}`,
);
export function avatarFromId(id: string): AgentAvatar {
  let hash = 2166136261;
  for (const character of id) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619) >>> 0;
  return { glyph: agentGlyphs[hash % 35], color: agentColors[Math.floor(hash / 35) % 10] };
}
export function randomAgentAvatar(): AgentAvatar {
  const values = crypto.getRandomValues(new Uint32Array(2));
  return { glyph: agentGlyphs[values[0] % 35], color: agentColors[values[1] % 10] };
}
export const agentSuggestions = [
  'Draft release notes for what merged each week',
  'Watch my apps and tell me when something fails',
  'Review my open pull requests',
  'Research a question for me',
];
export const weekDays = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
];
export function itemWhen(item: LooksAfterItem) {
  return item.when.every === 'change'
    ? 'On each change'
    : `${item.when.every === 'week' ? weekDays[item.when.day ?? 1] : 'Every day'} ${item.when.time}`;
}
export function itemSummary(item: LooksAfterItem, projects: { id: string; name: string }[] = []) {
  const where =
    typeof item.where === 'string'
      ? item.where === 'all-active'
        ? 'All Active'
        : 'All Active and Maintained'
      : item.where.projects.map((id) => projects.find((p) => p.id === id)?.name ?? id).join(', ');
  return `${where} · ${itemWhen(item)} · brings a ${item.brings.replaceAll('-', ' ')}`;
}
export const agentActions = [
  { id: 'start-task', name: 'Start a task', description: 'Work on a branch inside its limits' },
  {
    id: 'open-pull-request',
    name: 'Open a pull request',
    description: 'Bring a branch for review',
  },
  { id: 'merge', name: 'Merge a pull request', description: 'Apply a reviewed change' },
  { id: 'restart', name: 'Restart an app', description: 'Stop and start the running app' },
  { id: 'rollback', name: 'Roll back a release', description: 'Restore the previous release' },
] as const;
