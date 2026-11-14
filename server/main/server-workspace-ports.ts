// Preserve the API's eager evaluation prefix before the former collaboration auth import.
// Keep this before boot's api.ts import; workspace-product-ports.test.ts compares the full order.
import '../api/release-admission.ts';
import '../readiness.ts';
import '../readiness-integrity.ts';
import '../home-coordinator.ts';
import '../deployment-notification-service.ts';
import '../v2/releases-api.ts';
import '../v2/agent-runs.ts';
import '../api/shared.ts';
import '../workspace/read-state.ts';
import '../workspace/protocol.ts';
import '../workspace/checkpoint-commit.ts';
import { wireCollaborationPreferencesSource } from './workspace-collaboration-preferences.ts';
import { wireAgentInstructionsSource } from './workspace-agent-instructions.ts';
import { wireRepositoryProjectCreator } from './workspace-repository-project.ts';
import { wireWorkspaceLazyTools } from './workspace-lazy-tools.ts';

export function wireServerWorkspacePorts() {
  wireAgentInstructionsSource();
  wireRepositoryProjectCreator();
  wireCollaborationPreferencesSource();
  wireWorkspaceLazyTools();
}
