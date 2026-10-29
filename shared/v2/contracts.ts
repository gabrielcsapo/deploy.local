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
  outcome?: { text: string; tone: 'ok' | 'failed' | 'neutral' };
  answer?: {
    actionId: string;
    by: UserId;
    on: 'web' | 'iphone' | 'desktop' | 'cli';
    surface?: 'menu-bar';
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

export type LiveApp = AppHealth & {
  name: string;
  project?: string;
  address?: string;
  release?: string;
  releasedAt?: string;
};
export type LiveResponse = {
  rollbacks?: Rollback[];
  summary: { running: number; failing: number; warning: number; checkedAt: string };
  computers: {
    id: string;
    name: string;
    roles: Role[];
    online: boolean;
    cpu?: number;
    memory?: number;
    disk?: number;
    apps: LiveApp[];
  }[];
};
export type LiveAppResponse = {
  app: LiveApp;
  release?: Release;
  history: { at: string; failRate?: number; p95ms?: number }[];
};

export type Project = {
  id: string;
  name: string;
  apps: { id: string; name: string; kind: 'web' | 'worker' }[];
};

export type RollbackDataLoss = {
  backupId: string;
  capturedAt: string;
  apps: string[];
  summary: string;
};

export type ProjectSetting = {
  key: string;
  app?: string;
  type: string;
  value?: string | number | boolean | null;
  set: boolean;
  updatedAt: string;
};
export type ProjectSettings = { values: ProjectSetting[]; appliesOn: 'next-release' };

export type Computer = {
  id: string;
  name: string;
  nodeId?: string;
  workerIds: string[];
  roles: Role[];
  supportedRoles: Role[];
  online: boolean;
  platform?: string;
  architecture?: string;
  version?: string;
  cpu?: number;
  cpuModel?: string;
  memory?: { used?: number; total: number };
  disk?: { used?: number; total: number };
  doing: { id: string; kind: 'app' | 'task' | 'model' | 'job'; name: string; state: string }[];
};
export type ComputerRemoval = {
  computerId: string;
  allowed: boolean;
  reasons: string[];
  apps: { id: string; name: string; destinations: { id: string; name: string }[] }[];
  tasks: { id: string; name: string }[];
};
export type ModelChoice = { id: string; name: string; provider: string; model: string };
export type ModelDefaults = Record<
  'writing-code' | 'reviewing' | 'answering-questions',
  string | null
>;
export type ComputerModels = {
  defaults: ModelDefaults;
  choices: ModelChoice[];
  providers: {
    id: string;
    name: string;
    computers: string[];
    weekly?: { usedPercent: number; resetsAt?: number; checkedAt?: number };
  }[];
  local: { id: string; name: string; computer: string; loaded: boolean }[];
};
export type ComputerUpdates = {
  currentVersion?: string;
  latestRelease?: Release;
  projectId?: string;
  automatic: boolean;
  computers: {
    id: string;
    version?: string;
    targetVersion?: string;
    state: 'current' | 'waiting' | 'ready' | 'offline' | 'unavailable';
    reason?: string;
  }[];
};

export type BackupPoint = {
  id: string;
  name: string;
  projectId?: string;
  apps: string[];
  kind: 'scheduled' | 'manual' | 'pre-release' | 'recovery';
  createdAt: string;
  sizeBytes: number | null;
  contents: string[];
  destination: string;
  computer: string;
  releaseId?: string;
  verified: boolean;
  testedAt?: string;
  testStatus: 'passed' | 'failed' | 'untested';
  restoreAvailable: boolean;
  unavailableReason?: string;
};

export type BackupRestore = {
  id: string;
  backupId: string;
  projectId: string;
  state: 'creating' | 'ready' | 'switching' | 'live' | 'cancelled' | 'failed';
  createdAt: string;
  addresses: { app: string; url: string }[];
  releaseId?: string;
  retainedBackupId?: string;
  error?: string;
};

export type BackupsResponse = {
  backups: BackupPoint[];
  restores: BackupRestore[];
  schedules: {
    name: string;
    enabled: boolean;
    schedule: string;
    destination: string;
    contents: string;
  }[];
};

/** The legacy ApprovalAction retains ship for old clients; new rules never accept it. */
export type AgentApprovalAction =
  | Exclude<ApprovalAction, 'ship'>
  | 'start-task'
  | 'open-pull-request';
export type AgentApprovalRule = Omit<ApprovalRule, 'action'> & { action: AgentApprovalAction };
export type AgentConfiguration = Agent & {
  schedule?: { enabled: boolean; time: string };
  triggers?: { mention: boolean; disk: boolean };
  apps?: string[];
  /** The project whose code a background run works in; none gives the run an empty folder. */
  projectId?: string;
};
export type ApprovalSuggestion = { agent: string; action: 'rollback'; count: number };
export type AgentTracking = {
  running: { id: string; title: string; computer?: string; at?: string }[];
  watching: { id: string; title: string; projectId?: string }[];
  shipped: { id: string; title: string; at: string }[];
  /** Background runs, newest first, and what the last scheduled start did. */
  runs?: { id: string; title: string; at: string; status: string }[];
  schedule?: { day: string; result?: string; error?: string };
};

export type ProjectReleaseSettings = ProjectSettings & {
  keepReleases: number;
  verifyMigrations: boolean;
};

export type ComputerUpdateOverview = Omit<ComputerUpdates, 'computers'> & {
  automaticReason?: string;
  coordinatorReason?: string;
  computers: (Omit<ComputerUpdates['computers'][number], 'state'> & {
    state: ComputerUpdates['computers'][number]['state'] | 'updating' | 'failed';
  })[];
};
