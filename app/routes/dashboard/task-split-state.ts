export type SplitTab = 'computer' | 'changes' | 'activity';
export type SplitPreferences = {
  tabs: Record<string, SplitTab | null>;
  width: number;
  migratedTab: SplitTab | null;
};
const tabs = ['computer', 'changes', 'activity'];
export function splitPreference(saved: any, legacy: any = {}): SplitPreferences {
  return {
    tabs: Object.fromEntries(
      Object.entries(saved?.tabs ?? {}).map(([task, value]) => [
        task,
        tabs.includes(String(value)) ? (value as SplitTab) : null,
      ]),
    ),
    width: Math.max(
      320,
      Math.min(
        720,
        Number.isFinite(saved?.width)
          ? saved.width
          : Number.isFinite(legacy?.width)
            ? legacy.width
            : 400,
      ),
    ),
    migratedTab: saved
      ? saved.migratedTab === 'activity'
        ? 'activity'
        : null
      : legacy?.mode === 'open'
        ? 'activity'
        : null,
  };
}
export function selectedSplitTab(preferences: SplitPreferences, task: string) {
  return Object.hasOwn(preferences.tabs, task) ? preferences.tabs[task] : preferences.migratedTab;
}
export function selectSplitTab(
  preferences: SplitPreferences,
  task: string,
  tab: SplitTab | null,
  width = preferences.width,
): SplitPreferences {
  return {
    ...preferences,
    tabs: { ...preferences.tabs, [task]: tab },
    width: Math.max(320, Math.min(720, width)),
  };
}
export function toggledSplitTab(current: SplitTab | null, requested: SplitTab) {
  return current === requested ? null : requested;
}
/** Only a new pending request or non-ended session reveals Computer. */
export function controlRevealId(state: {
  requests?: { id: string; status: string }[];
  sessions: { id: string; status: string }[];
}) {
  const latest = state.sessions.at(-1);
  return (
    state.requests?.find((request) => request.status === 'pending')?.id ||
    (latest && !['stopped', 'suspended'].includes(latest.status) ? latest.id : '')
  );
}

export function listenForSplitEscape(target: EventTarget, close: () => void) {
  const key = (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      close();
    }
  };
  target.addEventListener('keydown', key);
  return () => target.removeEventListener('keydown', key);
}
export function restoreSplitFocus(opener: Pick<HTMLElement, 'isConnected' | 'focus'> | null) {
  if (opener?.isConnected) opener.focus({ preventScroll: true });
}
