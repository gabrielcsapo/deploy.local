import type { InboxItem } from '../../../../../shared/v2/contracts.ts';
import { formatTime } from '../data/time.ts';

// Legacy items may not yet carry a display name; never expose an unknown agent id.
const names: Record<string, string> = {
  warden: 'Warden',
  scout: 'Scout',
  agent: 'An agent',
  codex: 'Codex',
  claude: 'Claude',
  compatible: 'Model',
};
export function agentName(id: string) {
  return names[id] || 'An agent';
}
export function questionActions(item: InboxItem) {
  return {
    options: item.actions
      .filter((action) => !['answer', 'dismiss'].includes(action.id))
      .sort((a, b) => Number(!!b.primary) - Number(!!a.primary)),
    answer: item.actions.find((action) => action.id === 'answer'),
    dismiss: item.actions.find((action) => action.id === 'dismiss'),
  };
}
export function askedTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Asked · time unavailable';
  const minutes = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 60000));
  if (minutes < 1) return 'Asked just now';
  return `Asked ${minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`} ago`;
}
export function answerLabel(item: InboxItem) {
  return (
    item.actions.find((action) => action.id === item.answer?.actionId)?.label ||
    (item.actions.some((action) => action.id === 'rule') ? 'Allowed by rule' : 'Answered')
  );
}
export function answerDetails(item: InboxItem, now = new Date()) {
  const answer = item.answer;
  if (!answer)
    return item.actions.some((action) => action.id === 'rule')
      ? 'Allowed by rule'
      : 'Answered · details unavailable';
  const platform =
    answer.surface === 'menu-bar'
      ? 'from the menu bar'
      : {
          web: 'on the web',
          iphone: 'on iPhone',
          desktop: 'on this Mac',
          cli: 'in the terminal',
        }[answer.on];
  const day = formatTime(answer.at, 'day', now);
  return `you answered ${day === 'Yesterday' ? 'yesterday ' : ''}at ${formatTime(answer.at, 'clock')}${!['Today', 'Yesterday'].includes(day) ? ` on ${day}` : ''} ${platform}${answer.note ? ` · “${answer.note}”` : ''}`;
}
