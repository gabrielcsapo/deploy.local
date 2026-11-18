// Import after the test has selected its disposable DEPLOY_DATA_DIR.
import { wireAgentInstructionsSource } from './main/workspace-agent-instructions.ts';
import { wireRepositoryProjectCreator } from './main/workspace-repository-project.ts';
import { wireCollaborationPreferencesSource } from './main/workspace-collaboration-preferences.ts';
import { wireWorkspaceLazyTools } from './main/workspace-lazy-tools.ts';
import { wireLocalWorkerMedia } from './main/local-worker-media.ts';

import { wireTaskRunStarter } from './main/task-run-starter.ts';
import { wireQuestionAnswerResumer } from './main/question-answer-resumer.ts';
import { wireStateRefreshSources } from './main/state-refresh-sources.ts';
import { wireAgentChatSource } from './main/agent-chat-source.ts';
import { wireWorkerEntry } from './main/worker-entry.ts';

wireAgentInstructionsSource();
wireRepositoryProjectCreator();
wireCollaborationPreferencesSource();
wireWorkspaceLazyTools();
wireLocalWorkerMedia();

wireTaskRunStarter();
wireQuestionAnswerResumer();
wireStateRefreshSources();
wireAgentChatSource();
wireWorkerEntry();
