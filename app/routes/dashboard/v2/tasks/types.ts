import type { ConversationEvent, Release, Screenshot } from '../../../../../shared/v2/contracts';

export type TaskPull = {
  id: string;
  number: number;
  title: string;
  body?: string;
  status: string;
  revision: number;
  sourceBranch: string;
  targetBranch: string;
  taskIds: string[];
  updatedAt?: string;
};
export type TaskCheck = {
  id: string;
  name?: string;
  command?: string;
  status: string;
  output?: string;
  error?: string;
  headCommit?: string;
};
export type TaskView = {
  task: {
    id: string;
    title: string;
    projectId?: string;
    status: string;
    revision: number;
    sourceRef?: string;
    createdAt: string;
  };
  project?: { id: string; name: string; repository?: string };
  computer?: string;
  run?: { adapter: string; model?: string; status: string };
  events: ConversationEvent[];
  cursor: number;
  firstTask: boolean;
  pulls: TaskPull[];
  checks: TaskCheck[];
  screenshots: Screenshot[];
  releases: Release[];
  ship?: { ref?: string; runsOn?: string; address?: string; access?: string; data?: string };
};
export type TaskDiff = { patch: string; baseCommit?: string; headCommit?: string; status?: string };
