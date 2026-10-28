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
  startedAt?: string;
  finishedAt?: string;
  completedAt?: string;
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
    startedBy?: string;
    startedFrom?: string;
  };
  project?: { id: string; name: string; repository?: string };
  computer?: string;
  run?: { adapter: string; model?: string; status: string; updatedAt?: string };
  checkpoint?: { number: number; at: string };
  events: ConversationEvent[];
  cursor: number;
  firstTask: boolean;
  pulls: TaskPull[];
  checks: TaskCheck[];
  screenshots: (Screenshot & { requestedAt?: string })[];
  releases: Release[];
  ship?: { ref?: string; runsOn?: string; address?: string; access?: string; data?: string };
};
export type TaskDiff = { patch: string; baseCommit?: string; headCommit?: string; status?: string };
