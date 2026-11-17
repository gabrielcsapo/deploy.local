import type { RepeatingSender, TrafficResponse } from '../../../../../shared/v2/contracts';

/** A sender by the computer's name when it is one of the owner's, else by its address. */
export const senderName = (sender: { address: string; computer?: string }) =>
  sender.computer || sender.address;

export const share = (value: number) => `${Math.round(value * 100)}%`;

/** “every 2 seconds”, “every 0.4 seconds”, “every 3 minutes”. */
export function pace(perMinute: number) {
  if (perMinute <= 0) return '';
  const seconds = 60 / perMinute;
  if (seconds >= 90) return `every ${Math.round(seconds / 60)} minutes`;
  const rounded = seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds);
  return `every ${rounded} ${rounded === 1 ? 'second' : 'seconds'}`;
}

const list = (words: string[]) =>
  words.length < 3
    ? words.join(' and ')
    : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
const count = (value: number) => value.toLocaleString('en-US');
const thing = (routes: string[]) =>
  routes.every((route) => route.startsWith('GET ')) ? 'page' : 'thing';

export type SenderWarning = { key: string; title: string; text: string };

/**
 * One warning per sender on Traffic: who, what it keeps asking for, how often, since when and how
 * much of everything that is. `when` words a time; `bytes` words a size.
 */
export function trafficWarnings(
  traffic: Pick<TrafficResponse, 'repeating'>,
  dayRequests: number,
  when: (sender: RepeatingSender) => string,
  bytes: (value: number) => string,
): SenderWarning[] {
  const senders = new Map<string, RepeatingSender[]>();
  for (const sender of traffic.repeating)
    senders.set(sender.address, [...(senders.get(sender.address) ?? []), sender]);
  return [...senders].map(([address, rows]) => {
    const apps = [...new Set(rows.map((row) => row.app))];
    const routes = [...new Set(rows.map((row) => row.route))];
    const requests = rows.reduce((sum, row) => sum + row.requests, 0);
    const sent = rows.reduce((sum, row) => sum + row.sentBytes, 0);
    const oldest = rows.reduce((first, row) => (row.since < first.since ? row : first));
    const agent = rows.find((row) => row.agent)?.agent;
    // “to each … every 0.4 seconds” is the pace of one route, not of all of them together.
    const perMinute = Math.max(...rows.map((row) => row.perMinute));
    const name = senderName(rows[0]);
    return {
      key: address,
      title: `${name} keeps asking ${list(apps)} for the same ${thing(routes)}`,
      text: `It has sent ${list(routes)}${apps.length > 1 ? ' to each' : ''}${agent ? ` with ${agent}` : ''} ${pace(perMinute)} since ${when(oldest)}: ${count(requests)} requests and ${bytes(sent)} in the last 24 hours${dayRequests ? `, ${share(Math.min(1, requests / dayRequests))} of everything` : ''}. A script was probably left running on it.`,
    };
  });
}

/** The warning on one app's Requests page, for its busiest repeating sender. */
export function appWarning(
  repeating: RepeatingSender[],
  when: (sender: RepeatingSender) => string,
): SenderWarning | null {
  const sender = repeating[0];
  if (!sender) return null;
  const who = sender.computer ? `${sender.computer} (${sender.address})` : sender.address;
  return {
    key: `${sender.address} ${sender.route}`,
    title: `${share(sender.appShare)} of these requests are one ${sender.computer ? 'computer' : 'address'} asking for the same ${thing([sender.route])}`,
    text: `${who} has sent ${sender.route}${sender.agent ? ` with ${sender.agent}` : ''} ${pace(sender.perMinute)} since ${when(sender)}. A script was probably left running on it. The numbers below include it.`,
  };
}
