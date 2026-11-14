// Import after the test has selected its disposable DEPLOY_DATA_DIR.
import { wireAgentInstructionsSource } from './main/workspace-agent-instructions.ts';
import { wireRepositoryProjectCreator } from './main/workspace-repository-project.ts';
import { wireCollaborationPreferencesSource } from './main/workspace-collaboration-preferences.ts';
import { wireWorkspaceLazyTools } from './main/workspace-lazy-tools.ts';
import { wireLocalWorkerMedia } from './main/local-worker-media.ts';

wireAgentInstructionsSource();
wireRepositoryProjectCreator();
wireCollaborationPreferencesSource();
wireWorkspaceLazyTools();
wireLocalWorkerMedia();
