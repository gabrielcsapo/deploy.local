export type LogStreamState = {
  openStreams: number;
  hasOpened: boolean;
  finished: boolean;
};

export function logStreamStatus(state: LogStreamState, failed = false) {
  const label = failed
    ? 'Disconnected'
    : state.openStreams > 0
      ? 'Live'
      : !state.hasOpened && !state.finished
        ? 'Connecting'
        : 'Disconnected';
  return {
    label,
    kind: label === 'Live' ? ('active' as const) : ('inactive' as const),
    reconnect: label === 'Disconnected' && !failed,
  };
}
