import type { InboxItem } from '../../../../../shared/v2/contracts.ts';
import { formatTime } from '../data/time.ts';

// `warden` is deploy.local's release checks asking about a rollback; older items may say `scout`.
const names: Record<string, string> = {
  warden: 'deploy.local',
  scout: 'Agent',
  agent: 'Agent',
  codex: 'Codex',
  claude: 'Claude',
  compatible: 'Model',
};
export function agentName(id: string) {
  return names[id] || id;
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
