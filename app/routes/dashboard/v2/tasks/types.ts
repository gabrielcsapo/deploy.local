import type { TaskRequirementsSnapshot } from '../../../../../shared/v2/contracts';
import type {
  ConversationEvent,
  Release,
  Screenshot,
  TaskDesignCheck,
} from '../../../../../shared/v2/contracts';

export type TaskPull = {
  id: string;
  projectId?: string;
  number: number;
  title: string;
  body?: string;
  status: string;
  revision: number;
  sourceBranch: string;
  targetBranch: string;
  taskIds: string[];
  createdAt?: string;
  updatedAt?: string;
  author?: string;
  authorName?: string;
  mergedByName?: string;
  closedByName?: string;
  taskAuthor?: string;
  mergedBy?: string;
  mergedAt?: string;
  mergedCommit?: string;
  mergedTargetCommit?: string;
  closedBy?: string;
  closedAt?: string;
  checksPassed?: number;
  checkCount?: number;
  checksCommit?: string;
  release?: { id: string; commit?: string; at?: string };
  /** The merge last queued for it; its operation says whether it is running, landed or failed. */
  mergeOperationId?: string;
  bodyEditedBy?: string;
  bodyEditedAt?: string;
  files?: PullFile[];
};
export type PullFile = {
  id: string;
  name: string;
  kind: 'image' | 'video' | 'pdf' | 'text' | 'file';
  type: string;
  bytes: number;
  url: string;
};
export type TaskCheck = {
  id: string;
  name?: string;
  label?: string;
  source?: string;
  commit?: string;
  evidence?: string;
  durationMs?: number | null;
  piped?: boolean;
  createdAt?: string;
  updatedAt?: string;
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
  designCheck?: TaskDesignCheck;
  needs?: TaskRequirementsSnapshot['needs'];
  task: {
    id: string;
    title: string;
    projectId?: string;
    status: string;
    revision: number;
    sourceRef?: string;
    createdAt: string;
    updatedAt?: string;
    branch?: string;
    startedBy?: string;
    startedFrom?: string;
    startedModel?: string;
  };
  project?: { id: string; name: string; repository?: string; kind?: string; address?: string };
  agent?: { id: string; name: string };
  computer?: string;
  computerId?: string;
  run?: { adapter: string; model?: string; modelName?: string; status: string; updatedAt?: string };
  checkpoint?: { number: number; at: string };
  checkpoints?: TaskCheckpoint[];
  comparison?: { ahead: number; behind: number };
  events: ConversationEvent[];
  cursor: number;
  firstTask: boolean;
  pulls: TaskPull[];
  checks: TaskCheck[];
  screenshots: (Screenshot & { requestedAt?: string })[];
  releases: Release[];
  packages?: { name: string; version: string; previousVersion?: string }[];
  ship?: { ref?: string; runsOn?: string; address?: string; access?: string; data?: string };
};
export type TaskCheckpoint = {
  id: string;
  number: number;
  at: string;
  published?: boolean;
  commit?: string;
  checks: TaskCheck[];
};
export type TaskDiff = {
  patch: string;
  baseCommit?: string;
  headCommit?: string;
  status?: string;
  mergeable?: boolean;
  mergeBlock?: string | null;
  conflicts?: string[];
  fastForward?: boolean;
  mergeBase?: string;
};
