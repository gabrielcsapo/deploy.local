const marker = 'workspaceTaskHistory';
type Entry = { session: string; index: number };
/** Uses real browser entries, preserving the router's own state and scroll keys. */
export class TaskHistory {
  private session = Math.random().toString(36).slice(2);
  private index = 0;
  private end = 0;
  private readonly history: Pick<History, 'state' | 'replaceState' | 'back' | 'forward'>;
  constructor(history: Pick<History, 'state' | 'replaceState' | 'back' | 'forward'>) {
    this.history = history;
    this.mark();
  }
  private mark() {
    this.history.replaceState(
      { ...this.history.state, [marker]: { session: this.session, index: this.index } },
      '',
    );
  }
  get canBack() {
    return this.index > 0;
  }
  get canForward() {
    return this.index < this.end;
  }
  select(url: string, current: string, navigate: (url: string) => void) {
    if (url === current) return;
    navigate(url); // The router synchronously pushes before fetching the route.
    this.end = ++this.index;
    this.mark();
  }
  pop() {
    const entry = this.history.state?.[marker] as Entry | undefined;
    if (entry?.session === this.session) this.index = entry.index;
    else {
      this.index = this.end = 0;
      this.session = Math.random().toString(36).slice(2);
      this.mark();
    }
  }
  go(direction: -1 | 1) {
    if (direction === -1 && this.canBack) this.history.back();
    if (direction === 1 && this.canForward) this.history.forward();
  }
}

/**
 * Phone widths show either the task list or one task. A link straight to a task
 * (`/dashboard?task=<id>`, which notifications send) must open that task; without one the list
 * is the entry point, and Back returns to it.
 */
export function openedTaskSection(search: string, phone: boolean) {
  if (!phone) return 'conversation';
  return new URLSearchParams(search).get('task') ? 'conversation' : 'tasks';
}

export function taskHistoryShortcut(
  event: {
    key: string;
    metaKey: boolean;
    altKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    defaultPrevented?: boolean;
    isComposing?: boolean;
  },
  typing: boolean,
): -1 | 1 | null {
  if (typing || event.defaultPrevented || event.isComposing || event.ctrlKey || event.shiftKey)
    return null;
  if (event.metaKey && !event.altKey) {
    if (event.key === '[') return -1;
    if (event.key === ']') return 1;
  }
  if (event.altKey && !event.metaKey) {
    if (event.key === 'ArrowLeft') return -1;
    if (event.key === 'ArrowRight') return 1;
  }
  return null;
}
