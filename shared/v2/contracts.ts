export type AgentId = string;
export type UserId = string;

// One union for everything a conversation shows. Clients render these; agents never send free-form UI.
export type ConversationEvent =
  | { kind: 'you'; id: string; at: string; text: string; attachments: Attachment[]; model?: string }
  | { kind: 'reply'; id: string; at: string; agent: AgentId; paragraphs: string[] }
  | { kind: 'worklog'; id: string; at: string; summary: string; steps: WorkStep[]; live: boolean }
  | { kind: 'decision'; id: string; at: string; inboxItemId: string } // renders the InboxItem in place
  | { kind: 'task'; id: string; at: string; taskId: string } // "started a task" link card
  | { kind: 'release'; id: string; at: string; releaseId: string }
  | { kind: 'screenshot'; id: string; at: string; screenshotId: string }
  | {
      kind: 'report';
      id: string;
      at: string;
      title: string;
      sections: { title: string; body: string }[];
    };

export type WorkStep = {
  icon: 'file' | 'edit' | 'terminal' | 'pulse' | 'logs' | 'search';
  text: string;
  added?: number;
  removed?: number;
};

// Waiting on you. The only thing that shows "!".
export type InboxItem = {
  id: string;
  kind: 'question' | 'merge' | 'rollback' | 'control' | 'install' | 'other';
  title: string; // "Roll back home-gym?"
  text: string; // one or two sentences of why
  from: AgentId;
  projectId?: string;
  taskId?: string;
  createdAt: string;
  actions: { id: string; label: string; primary?: boolean; confirm?: string }[];
  state: 'waiting' | 'answered' | 'expired' | 'withdrawn';
  answer?: {
    actionId: string;
    by: UserId;
    on: 'web' | 'iphone' | 'desktop' | 'cli';
    at: string;
    note?: string;
  };
};

// A release is the whole project.
export type Release = {
  id: string; // short commit, e.g. "9c3e1fa"
  projectId: string;
  source: { kind: 'pr' | 'ship' | 'cli' | 'pipeline'; ref: string }; // "PR #43"
  startedBy: UserId; // always a person; agents can't start releases
  apps: { appId: string; from?: string; to: string }[];
  migrations: { id: string; title: string; reversible: boolean }[];
  backupId?: string; // taken before activate when a migration is irreversible
  steps: {
    name: 'prepare' | 'verify' | 'activate' | 'watch';
    state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
    startedAt?: string;
    endedAt?: string;
    detail?: string;
  }[];
  state: 'running' | 'live' | 'failed' | 'rolled-back' | 'superseded';
};
export type Rollback = {
  id: string;
  projectId: string;
  from: string;
  to: string;
  reason: string;
  approvedBy: UserId | 'rule';
  ruleId?: string;
  steps: Release['steps'];
};

// Health in plain words. A worker has no address, so health is jobs, queue, process and heartbeat.
export type AppHealth = {
  appId: string;
  kind: 'web' | 'worker';
  state: 'healthy' | 'warning' | 'failing' | 'stopped';
  summary: string; // "38% of jobs error since 1:58 PM"
  http?: { path: string; status: number; p95ms: number; reqPerMin: number };
  jobs?: { perMin: number; failRate: number; baselineFailRate: number };
  queue?: { depth: number; oldestSec: number };
  restarts?: { count: number; windowSec: number };
  heartbeatAt?: string;
};

export type Role = 'coordinator' | 'take-tasks' | 'run-apps' | 'serve-models' | 'use-screen';
export type ApprovalAction =
  | 'merge'
  | 'ship'
  | 'rollback'
  | 'restart'
  | 'install'
  | 'change-secrets'
  | 'use-screen'
  | 'spend';
export type ApprovalRule = {
  id: string;
  agent: AgentId;
  action: ApprovalAction;
  projectId?: string;
  mode: 'ask' | 'allow' | 'never';
  limit?: string;
};
export type Agent = {
  id: AgentId;
  name: string;
  job: string;
  computers: string[];
  createdBy: UserId;
};

export type Screenshot = {
  id: string;
  taskId: string;
  target: { kind: 'web' | 'ios-simulator' | 'desktop'; url?: string; device?: string };
  takenAt: string;
  image: string;
  markup?: Markup;
};
export type Markup = {
  strokes: { tool: 'pen' | 'arrow'; color: 0 | 1 | 2; points: [number, number][] }[];
  texts: { x: number; y: number; text: string; color: 0 | 1 | 2 }[];
};
export type Attachment = {
  kind: 'photo' | 'file' | 'screenshot' | 'project-file';
  name: string;
  bytes: number;
  ref: string;
};
