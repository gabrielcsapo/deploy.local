// Preserve coordination-api -> update-base's eager prefix before collaboration preferences.
import '../workspace/task-workspace.ts';
import '../kernel/http.ts';
import '../workspace/protocol.ts';
import '../workspace/checkpoint-commit.ts';
import { wireCollaborationPreferencesSource } from './workspace-collaboration-preferences.ts';
import { wireWorkspaceLazyTools } from './workspace-lazy-tools.ts';

export function wireLocalWorkerTools() {
  wireCollaborationPreferencesSource();
  wireWorkspaceLazyTools();
}
