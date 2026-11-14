import type { StateRefreshSources } from '../contracts/state-refresh-sources.ts';

let provider: StateRefreshSources | undefined;

export function registerStateRefreshSources(value: StateRefreshSources) {
  provider = value;
}

export function requireStateRefreshSources(processName: string): StateRefreshSources {
  if (!provider) throw new Error(`StateRefreshSources is not wired in ${processName}`);
  return provider;
}
