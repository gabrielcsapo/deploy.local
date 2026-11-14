// Preserve coordination-api's eager prefix and the former agent-context-store import slot.
import '../workspace/task-workspace.ts';
import '../kernel/http.ts';
import { wireAgentInstructionsSource } from './local-worker-instructions.ts';
import { wireLocalWorkerTools } from './local-worker-tools.ts';

export function wirePreviewWorkspaceTools() {
  wireAgentInstructionsSource();
  wireLocalWorkerTools();
}
