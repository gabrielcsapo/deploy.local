import { preferences } from '../v2/auth-store.ts';
import { registerCollaborationPreferencesSource } from '../workspace/collaboration-preferences-port.ts';

export function wireCollaborationPreferencesSource() {
  registerCollaborationPreferencesSource(preferences);
}
