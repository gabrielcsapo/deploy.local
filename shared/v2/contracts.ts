export type TaskRequirementsSnapshot = {
  needs?: {
    tools: string[];
    why?: string;
    waiting: boolean;
    asked: { id: string; name: string; online: boolean; has: Record<string, boolean | null> }[];
  };
};

export type AgentId = string;
export type UserId = string;

export type DesignCheckBoard = { file: string; title: string; widths: number[]; height: number };
export type DesignBuildReport = {
  state: 'waiting' | 'matches' | 'differs' | 'kept';
  at?: string;
  captures?: number;
  differences?: number;
  text?: string;
  why?: string;
  board?: string;
  width?: number;
  screenshotId?: string;
  appCommit?: string;
  comparisons?: {
    board: string;
    width: number;
    screenshotId: string;
    image: string;
    height: number;
  }[];
};
export type TaskDesignCheck = DesignBuildReport & {
  reviewId: string;
  title: string;
  approvedAt: string;
  commit: string;
  boards: DesignCheckBoard[];
  reviewHref: string;
  decisionHref?: string;
};
export type DesignBuildDecision = TaskDesignCheck & {
  projectId: string;
  capture?: { image: string; width: number; height: number };
};

// One union for everything a conversation shows. Clients render these; agents never send free-form UI.
export type ConversationEvent =
  | { kind: 'you'; id: string; at: string; text: string; attachments: Attachment[]; model?: string }
  | {
      kind: 'reply';
      id: string;
      at: string;
      agent: AgentId;
      paragraphs: string[];
      receipts?: AgentReceipt[];
    }
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
  /** A closer picture than `icon`, for clients that know it; `icon` stays for the rest. */
  glyph?: 'deploy' | 'note';
  /** How it went: "Live at drop.local", "Passed on SER", "Failed: health check". */
  outcome?: string;
  /** Where the outcome points, such as the app a deploy made live. */
  outcomeHref?: string;
  tone?: 'fail' | 'warn';
  /** Still running. */
  live?: boolean;
  seconds?: number;
  /** Where to look next, such as View logs or Output. */
  links?: { label: string; href: string }[];
  /** Why it failed or stopped, and the last lines of its log, shown when the step is opened. */
  reason?: string;
  tail?: string[];
  /** The step's run and item, `work:<run>:<item>`, to load what it did when it opens. */
  id?: string;
  /** Opening it loads its detail: the command and output, the diff, what a search found. */
  opens?: boolean;
  /** What a search found, at the row's end: "3 files". */
  found?: string;
};

/** One row of a step's diff. Line numbers are left out when the edit doesn't say where it landed. */
export type StepDiffRow = {
  kind: 'add' | 'del' | 'same' | 'hunk';
  old?: number;
  new?: number;
  text: string;
};

/** What opening a step shows. */
export type StepDetail = {
  command?: string;
  /** The last lines of its output. */
  output?: string[];
  exitCode?: number;
  path?: string;
  diff?: StepDiffRow[];
  /** What a search found, a line each. */
  found?: string[];
  /** Lines left out above the output, or below the diff or the search results. */
  more?: number;
};

// Waiting on you. The only thing that shows "!".
export type InboxItem = {
  id: string;
  kind: 'question' | 'merge' | 'rollback' | 'control' | 'install' | 'other';
  title: string; // "Roll back home-gym?"
  text: string; // one or two sentences of why
  from: AgentId;
  fromName?: string;
  context?: { text: string; messageId: string; createdAt: string } | null;
  projectId?: string;
  projectName?: string;
  taskId?: string;
  createdAt: string;
  actions: { id: string; label: string; primary?: boolean; confirm?: string }[];
  state: 'waiting' | 'answered' | 'expired' | 'withdrawn';
  outcome?: { text: string; tone: 'ok' | 'failed' | 'neutral' };
  designCheck?: DesignBuildDecision;
  /** Set on a design review of a document: the document's folder name under artifacts/. */
  document?: string;
  answer?: {
    actionId: string;
    by: UserId;
    on: 'web' | 'iphone' | 'desktop' | 'cli';
    surface?: 'menu-bar';
    at: string;
    note?: string;
  };
};

export type ReleasePart = {
  name: 'copy data' | 'build image' | 'start' | 'wait for health';
  app: string;
  startedAt: string;
  endedAt?: string;
};

// A release is the whole project.
export type Release = {
  id: string; // Stable release identity; display source.commit when available.
  projectId: string;
  source: {
    kind: 'pr' | 'ship' | 'cli' | 'pipeline';
    ref: string; // Source label, e.g. "PR #43".
    commit?: string;
    message?: string;
    gitRef?: string;
  };
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
    parts?: ReleasePart[];
    verifyEmptyResources?: { app: string; resource: string }[];
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
  source?: Release['source'];
  fromDiscover?: boolean;
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
  stage?: 'active' | 'maintained' | 'done';
  fromDiscover?: boolean;
  id: string;
  name: string;
  apps: { id: string; name: string; kind: 'web' | 'worker' }[];
  /** The fields below are only on the Projects list (`ProjectListResponse`). */
  /** When any branch of its repository last moved. */
  changedAt?: string;
  /** Open pull requests, when there are any. */
  openPulls?: number;
  /** Subject of the newest commit, on repository rows. */
  lastCommit?: string;
  /** Requests in each of the last 24 hours, oldest first, for a project with a web app. */
  traffic?: { from: number; hourly: number[] };
};

export type ProjectListGroup = 'live' | 'repositories' | 'archived';
/** The Projects page: what runs, repositories that never shipped, and archived projects. */
export type ProjectListResponse = {
  live: Project[];
  /** Newest change first, one page at a time. */
  repositories: Project[];
  archived: Project[];
  /** Repositories that match and were not sent. */
  more: number;
  /** Every project, whatever is shown or searched. */
  counts: Record<ProjectListGroup, number>;
};

/** Diagnostics → Traffic, and the warning on an app's Requests page. */
export type RepeatingSender = {
  app: string;
  /** The address as recorded, without the IPv4-in-IPv6 prefix. */
  address: string;
  /** One of the owner's computers, when the address is its own. */
  computer?: string;
  /** “curl”, “Safari”, or null when the agent says nothing useful. */
  agent: string | null;
  /** Method and path, with IDs folded to :id. */
  route: string;
  /** In the last 24 hours. */
  requests: number;
  /** Its share of that route's requests in the last hour, 0 to 1. */
  routeShare: number;
  /** Its share of all the app's requests, 0 to 1. */
  appShare: number;
  perMinute: number;
  sentBytes: number;
  since: number;
  /** True when it has been going at least as long as the lookback; `since` is then a floor. */
  sinceOrEarlier: boolean;
};

export type TrafficApp = {
  name: string;
  /** The project it belongs to, for the link to its Requests page. */
  project?: string;
  requests: number;
  perMinuteNow: number;
  serverErrors: number;
  /** Null when the range is longer than senders are read for. */
  sentBytes: number | null;
  topSender: { address: string; computer?: string; share: number; repeating: boolean } | null;
};

export type TrafficResponse = {
  range: '1h' | '24h' | '7d' | '30d';
  from: number;
  to: number;
  requests: number;
  perMinuteNow: number;
  serverErrors: number;
  /** Bytes and senders cover this much of the range: all of it up to 24 hours. */
  sendersWindowMs: number;
  sentBytes: number;
  receivedBytes: number;
  topSender: { address: string; computer?: string; share: number } | null;
  series: { bucketMs: number; points: { at: number; perMinute: number }[] };
  apps: TrafficApp[];
  repeating: RepeatingSender[];
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
  /** Programs this computer has said it has, when a task asked. */
  has?: string[];
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
export type ModelChoice = {
  id: string;
  name: string;
  provider: string;
  model: string;
  /** Reasoning efforts this model takes, lowest first; empty when it has none to choose. */
  efforts?: string[];
};
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
    /** The workers signed in to this provider, to match against a computer's workerIds. */
    workers?: string[];
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
export type AgentAvatar = { glyph: string; color: string };

/** Design review coordinates are CSS pixels in the named native viewport, never tile pixels. */
export type DesignRect = { x: number; y: number; w: number; h: number };
export type DesignReviewChange = { layer: string; words: string };
export type DesignReviewPreview = {
  layers?: { before: Record<string, DesignRect>; after: Record<string, DesignRect> };
  width: number;
  height: number;
  before: string | null;
  after: string | null;
  areas: (DesignReviewChange & { before: DesignRect | null; after: DesignRect | null })[];
  crop: DesignRect;
};
export type DesignReviewDrawing = {
  side: 'before' | 'after';
  nativeWidth: number;
  nativeHeight: number;
  anchor: { x: number; y: number };
  strokes: { x: number; y: number }[][];
  weight: number;
};
export type DesignReviewPin = {
  id: string;
  number: number;
  drawing?: DesignReviewDrawing;
  layer?: string;
  offset?: { x: number; y: number };
  area?: DesignRect;
  board: string;
  noteId: string | null;
  width: number;
  revision: string;
  x: number;
  y: number;
  text: string;
  author: string;
  resolved: boolean;
  reply: string | null;
  createdAt: string;
  /** The review round the pin was made in. Absent from older coordinators. */
  round?: number;
};
export type DesignReviewResolution = {
  file: string;
  mainExists?: boolean;
  proposalExists?: boolean;
  kind: 'kept-both' | 'same-part';
  mainChanged: string;
  proposalChanged: string;
  detail: string;
  choice: 'main' | 'proposal' | null;
};
export type DesignReviewScreen = {
  resolution?: DesignReviewResolution;
  main?: string;
  file: string;
  title: string;
  w: number;
  h: number;
  widths: number[];
  page: string | null;
  pageId: string | null;
  index: number | null;
  count: number | null;
  notes: string | null;
  added: boolean;
  removed: boolean;
  status: 'changed' | 'new' | 'removed';
  before: string;
  after: string;
  changes: DesignReviewChange[];
  /** Compatibility with older clients: plain element words, never diff descriptions. */
  lines: string[];
  seen: boolean;
  /** The round the screen was ticked in, while it is seen. Absent from older coordinators. */
  seenInRound?: number;
  changedSinceReview: boolean;
  conflict: boolean;
  /** Present with GET review?previews=all; otherwise load /review/preview per viewport. */
  previews?: Record<number, DesignReviewPreview>;
  /**
   * On the review only as the screen to look at a shared part on (`DesignReview.parts`): it has
   * no change of its own, and its seen is the part's.
   */
  instanceOnly?: boolean;
};
/**
 * A design-system component the branch changed. Landing re-renders every instance of it, so it is
 * one thing to approve however many screens show it.
 */
export type DesignReviewPart = {
  /** The component's ID in the design system's library. */
  component: string;
  name: string;
  /** How many screens show it: the screens landing re-renders. */
  screens: number;
  /** The screen to look at it on; ticking that screen ticks the part. */
  lookAt: { file: string; title: string };
  seen: boolean;
  /** False when the component is as it was in the owner's last review. Absent from older coordinators. */
  changedSinceReview?: boolean;
};
export type DesignReviewRow = {
  changeWords?: string;
  addedIcon?: boolean;
  removedIcon?: boolean;
  id: string;
  title: string;
  status: 'changed' | 'new' | 'removed' | 'looksSame' | 'pixelsOnly';
  screens: string[];
  added: string[];
  removed: string[];
  variations: number;
  nothingElse: boolean;
  seen: boolean;
};
export type DesignApproved = {
  id: string;
  title: string;
  project: string;
  detail: string;
};
export type DesignReviewSummary = {
  id: string;
  title: string;
  summary: string | null;
  projectId: string;
  project: string;
  branch: string;
  proposer: { id: string | null; name: string; avatar: AgentAvatar | null };
  createdAt: string;
  counts: { screens: number; changed: number; new: number; removed: number };
  stale: boolean;
  conflicts: string[];
  resolutions?: DesignReviewResolution[];
};
export type DesignReview = DesignReviewSummary & {
  /** The design's API path: /api/projects/<id>/design, or …/artifacts/<name>/design. */
  api?: string;
  item: InboxItem;
  task: string | null;
  /** Available original proposer task; absent for a person or a cancelled/archived task. */
  proposerTaskId?: string | null;
  before: string;
  after: string;
  main: string;
  updatedWithMainAt: string | null;
  round: number;
  previousItemId: string | null;
  changes?: DesignReviewRow[];
  landing?: {
    at: string;
    state: 'pending' | 'landed' | 'conflict' | 'failed';
    commit?: string;
    /** After landing: whether the design branch was removed, or why it was kept. */
    branch?: { name: string; removed: boolean; kept?: string };
    /** Explicitly requested build; legacy records may contain a failed or skipped attempt. */
    build?: {
      name?: string;
      at: string;
      taskId?: string;
      started?: boolean;
      failed?: string;
      skipped?: boolean;
    };
  };
  /** The owner's last Ask for changes or Ask to update: how many notes, and who has them. */
  feedback?: {
    actionId: 'changes' | 'update';
    notes: number;
    delivery: 'task' | 'terminal' | 'nobody';
    /** The computer whose terminal was waiting, for a terminal delivery. */
    computer?: string;
    taskId?: string;
  } | null;
  boards: DesignReviewScreen[];
  /** Shared parts the branch changed, each one unit to approve. Absent from older coordinators. */
  parts?: DesignReviewPart[];
  groups: { id: string | null; title: string | null; boards: string[] }[];
  notes: (import('./design').NoteChange & { page: string | null })[];
  pins: DesignReviewPin[];
};
export type LooksAfterItem = {
  id: string;
  what: string;
  where: 'all-active' | 'active-and-maintained' | { projects: string[] };
  when: { every: 'week' | 'day' | 'change'; day?: number; time: string; timezone: string };
  brings: 'pull-request' | 'design-review' | 'question' | 'message';
  confirmedAt?: string;
  nextAt?: string;
};
// Replies saved before Looks after receipts replaced job receipts may still hold { kind: 'job' }; it is not shown.
export type AgentReceipt = { kind: 'job' } | { kind: 'looks-after'; itemId: string };
export type AgentConfiguration = Agent & {
  avatar?: AgentAvatar;
  looksAfter?: LooksAfterItem[];
  lastMessage?: { text: string; at: string };
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
  runs?: { id: string; title: string; at: string; status: string; itemId?: string }[];
  schedule?: { day: string; result?: string; error?: string };
};

export type ProjectReleaseSettings = ProjectSettings & {
  installThroughDeploy: boolean;
  keepReleases: number;
  verifyMigrations: boolean;
};

/** The coordinator updating itself to its own repository's main, outside its service. */
export type SelfUpdateStep = {
  id: 'prepare' | 'backup' | 'restart' | 'check';
  state: 'waiting' | 'running' | 'done' | 'failed' | 'skipped';
  detail?: string;
  startedAt?: string;
  finishedAt?: string;
};
export type SelfUpdateRun = {
  id: string;
  from: string;
  to: string;
  state: 'running' | 'done' | 'failed';
  startedAt: string;
  startedBy: string;
  finishedAt?: string;
  steps: SelfUpdateStep[];
  error?: string;
  /** Activation failed and the previous release is serving again. */
  rolledBack?: boolean;
};
export type SelfUpdateChange = { sha: string; subject: string; date: string };
export type SelfUpdateStatus =
  | { supported: false; reason: string }
  | {
      supported: true;
      computer: string;
      running: string;
      main: string;
      ahead: number;
      changes: SelfUpdateChange[];
      run?: SelfUpdateRun;
      estimateMs: number;
    };

export type ComputerUpdateOverview = Omit<ComputerUpdates, 'computers'> & {
  automaticReason?: string;
  coordinatorReason?: string;
  computers: (Omit<ComputerUpdates['computers'][number], 'state'> & {
    state: ComputerUpdates['computers'][number]['state'] | 'updating' | 'failed';
  })[];
};

export type * from './workspace.ts';
