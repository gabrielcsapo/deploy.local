/** The task browser: the headless Chromium a worker runs for deploy_control, seen from the task page. */
export type ControlSession = {
  id: string;
  kind: 'browser' | 'computer';
  status: string;
  controlOwner: string;
  generation: string;
  workerId: string;
  targetLabel?: string;
  reason?: string;
  createdAt: string;
  updatedAt?: string;
};
export type ControlCommand = {
  id: string;
  sessionId: string;
  status: 'queued' | 'running' | 'succeeded' | 'unknown' | 'cancelled' | string;
  controller: string;
  createdAt: string;
  completedAt?: string;
  error?: string | null;
};
export type ControlState = {
  sessions: ControlSession[];
  commands: ControlCommand[];
};
export type ControlSnapshot = {
  url?: string;
  title?: string;
  image?: string;
  mimeType?: string;
  width?: number;
  height?: number;
  capturedAt?: string;
  commandId?: string;
};
export type BrowserAction =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'inspect' }
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number }
  | { type: 'text'; text: string }
  | { type: 'press'; key: string };

const live = ['opening', 'active', 'transferring'];
export const sessionLive = (session?: ControlSession) => !!session && live.includes(session.status);

/** The browser session to show: the live one, else the most recent one that ended. */
export function taskBrowser(state?: ControlState | null) {
  const browsers = (state?.sessions || []).filter((session) => session.kind === 'browser');
  const byNewest = [...browsers].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return byNewest.find(sessionLive) || byNewest[0];
}

/** Who has the controls, from this window's point of view. */
export function browserController(session: ControlSession | undefined, clientId: string) {
  if (!session || !sessionLive(session)) return 'ended' as const;
  if (session.controlOwner === `user:${clientId}`)
    return session.status === 'active' ? ('you' as const) : ('taking' as const);
  if (session.controlOwner.startsWith('user:')) return 'elsewhere' as const;
  return session.status === 'transferring' ? ('returning' as const) : ('agent' as const);
}

/** The newest command for the session that left a new picture behind. */
export function latestFrame(state: ControlState | null | undefined, sessionId?: string) {
  return (state?.commands || [])
    .filter((command) => command.sessionId === sessionId && command.status === 'succeeded')
    .at(-1)?.id;
}

export function commandPending(state: ControlState | null | undefined, sessionId?: string) {
  return (state?.commands || []).some(
    (command) => command.sessionId === sessionId && ['queued', 'running'].includes(command.status),
  );
}

/** A point on the shown picture, in the page's own pixels (the worker's 1280×800 viewport). */
export function pagePoint(
  box: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
  width = 1280,
  height = 800,
) {
  const clamp = (value: number, max: number) => Math.min(max - 1, Math.max(0, Math.round(value)));
  return {
    x: clamp(((clientX - box.left) / box.width) * width, width),
    y: clamp(((clientY - box.top) / box.height) * height, height),
  };
}

const named = new Set([
  'Enter',
  'Backspace',
  'Tab',
  'Escape',
  'Delete',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
]);
/** A key pressed on the picture: typed text, or a key (with its modifiers) for Playwright. */
export function keyAction(event: {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
}): BrowserAction | null {
  const modifiers = [
    event.ctrlKey && 'Control',
    event.metaKey && 'Meta',
    event.altKey && 'Alt',
  ].filter(Boolean) as string[];
  if (event.key.length === 1 && !modifiers.length) return { type: 'text', text: event.key };
  if (event.key.length === 1 || named.has(event.key)) {
    if (event.shiftKey && event.key.length > 1) modifiers.push('Shift');
    return { type: 'press', key: [...modifiers, event.key].join('+') };
  }
  return null;
}

/** What someone typed in the address field, as a URL the worker accepts. */
export function browserAddress(value: string) {
  const text = value.trim();
  if (!text) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  try {
    const url = new URL(withScheme);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function elapsed(since: string, now = Date.now()) {
  const seconds = Math.max(0, Math.floor((now - Date.parse(since)) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

/** Steps waiting their turn: one runs at a time, and letters typed meanwhile become one step. */
export function queueAction(queue: BrowserAction[], action: BrowserAction): BrowserAction[] {
  const last = queue.at(-1);
  if (action.type === 'text' && last?.type === 'text')
    return [...queue.slice(0, -1), { type: 'text', text: last.text + action.text }];
  if (action.type === 'scroll' && last?.type === 'scroll')
    return [...queue.slice(0, -1), { type: 'scroll', x: last.x + action.x, y: last.y + action.y }];
  return [...queue, action];
}

/** Whether a step this window sent is still running (or not yet seen in the latest read). */
export function stepRunning(state: ControlState | null | undefined, commandId?: string) {
  if (!commandId) return false;
  const command = state?.commands.find((entry) => entry.id === commandId);
  return !command || ['queued', 'running'].includes(command.status);
}
