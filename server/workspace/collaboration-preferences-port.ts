import type { CollaborationPreferencesSource } from '../contracts/collaboration-preferences.ts';

let provider: CollaborationPreferencesSource | undefined;

export function registerCollaborationPreferencesSource(value: CollaborationPreferencesSource) {
  provider = value;
}

export function requireCollaborationPreferencesSource(
  processName: string,
): CollaborationPreferencesSource {
  if (!provider) throw new Error(`CollaborationPreferencesSource is not wired in ${processName}`);
  return provider;
}
