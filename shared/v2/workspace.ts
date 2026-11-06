// Workspace wire values decoded by the iPhone client. No runtime dependency on the server.
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };

export type WorkspaceState = {
  version: number;
  cursor: number;
  projects: WorkspaceProject[];
  tasks: WorkspaceTask[];
  runs: Run[];
  workers: Worker[];
  adapters: Adapter[];
};

export type WorkspaceProject = {
  id: string;
  name: string;
  owner: string;
  sourcePath?: string | null;
  repositoryPath: string;
  createdAt: string;
};

export type WorkspaceTask = {
  queue?: RunQueue | null;
  waitingForAnswer?: boolean | null;
  pull?: TaskPullSummary | null;
  controlRequest?: ControlRequestSummary | null;
  baseUpdate?: BaseUpdate | null;
  workspaceStatus?: string | null;
  id: string;
  projectId?: string | null;
  workerId?: string | null;
  title: string;
  status: string;
  revision: number;
  workspacePath: string;
  remoteWorkspacePath?: string | null;
  baseRevision: string;
  createdAt: string;
  updatedAt: string;
};

export type TaskPullSummary = {
  id: string;
  number: number;
  status: string;
};

export type ControlRequestSummary = {
  id: string;
  kind: string;
  targetLabel: string;
  workerName: string;
  viewOnly?: boolean | null;
  desktopInput?: boolean | null;
  targetReason?: string | null;
  record?: boolean | null;
  expiresAt: number;
};

export type PublishDefaults = {
  title: string;
  body: string;
};

export type RunQueue = {
  moveUnavailableReason?: string | null;
  reason: string;
  position?: number | null;
  total: number;
  alternatives: QueueComputer[];
};

export type QueueComputer = {
  activeTaskCount?: number | null;
  queuedTaskCount?: number | null;
  id: string;
  name: string;
};

export type Run = {
  queue?: RunQueue | null;
  agentContext?: string | null;
  agentContextAt?: string | null;
  id: string;
  taskId: string;
  adapter: string;
  model?: string | null;
  effort?: string | null;
  status: string;
  sessionId?: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  stopRequested?: boolean | null;
  recoveryView?: RunRecovery | null;
};

export type RunRecovery = {
  state: string;
  title: string;
  detail: string;
  canMarkStopped: boolean;
  stopRequested: boolean;
};

export type MessageDeployment = {
  application?: string | null;
  status: string;
  url?: string | null;
};

export type Message = {
  deployment?: MessageDeployment | null;
  attachmentIds?: string[] | null;
  id: string;
  taskId: string;
  role: string;
  content: string;
  createdAt: string;
  runId?: string | null;
  isProgress?: boolean | null;
};

export type TaskActivity = {
  id: string;
  status: string;
  summary: string;
  items: ActivityItem[];
};

export type ActivityItem = {
  id: string;
  kind: string;
  title: string;
  status: string;
  detail: string;
  output: string;
  source?: string | null;
  exitCode?: number | null;
  background: boolean;
};

export type WorkspaceEvent = {
  cursor: number;
  taskId: string;
  runId?: string | null;
  type: string;
  payload: JSONValue;
  createdAt: string;
};

export type ModelOption = {
  id: string;
  name: string;
  efforts: string[];
};

export type AgentOption = {
  id: string;
  models: ModelOption[];
  efforts: string[];
};

export type ProviderUsageWindow = {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: number | null;
};

export type ProviderUsage = {
  id: string;
  name: string;
  status: string;
  plan?: string | null;
  checkedAt?: number | null;
  windows: ProviderUsageWindow[];
};

export type DesktopCaptureStatus = {
  available: boolean;
  reason: string;
  sessionType?: string | null;
  desktop?: string | null;
  portalAvailable?: boolean | null;
  grantStored?: boolean | null;
  socketPath?: string | null;
};

export type NodePermission = {
  id: string;
  label: string;
  state: string;
  summary: string;
  step?: NodePermissionStep | null;
};

export type ComputerRole = {
  state: string;
  reason: string;
  fix?: string | null;
};

export type Worker = {
  activeTaskCount?: number | null;
  queuedTaskCount?: number | null;
  build?: WorkerBuild | null;
  agentTools?: string[] | null;
  update?: WorkerUpdate | null;
  id: string;
  name: string;
  platform: string;
  architecture: string;
  status: string;
  capabilities: string[];
  modelOptions?: AgentOption[] | null;
  providers?: ProviderUsage[] | null;
  desktopCapture?: DesktopCaptureStatus | null;
  connections?: WorkerProviderConnection[] | null;
  permissions?: NodePermission[] | null;
  roles?: Record<string, ComputerRole> | null;
};

export type WorkerProviderConnection = {
  provider: string;
  available: boolean;
  enabled?: boolean | null;
};

export type Adapter = {
  id: string;
  name: string;
  available: boolean;
  capabilities: Record<string, boolean>;
  billingMode: string;
};

export type WorkspaceJob = {
  runId?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  name?: string | null;
  id: string;
  createdAt?: string | null;
  workerId?: string | null;
  waitingReason?: string | null;
  command: string;
  status: string;
  digest: string;
  output: string;
  truncated: boolean;
  outputTruncated?: boolean | null;
  exitCode?: number | null;
  error?: string | null;
  stopRequested?: boolean | null;
  artifactPaths?: JobArtifactRequest[] | null;
  artifacts?: JobArtifact[] | null;
};

export type JobArtifactRequest = {
  path: string;
  caption?: string | null;
};

export type JobArtifact = {
  path: string;
  name: string;
  caption?: string | null;
  attachmentId?: string | null;
  kind?: string | null;
  bytes?: number | null;
  skipped?: string | null;
};

export type TaskCheckpointSummary = {
  id: string;
  createdAt: string;
  fileCount: number;
  changedFileCount?: number | null;
  fresh: boolean;
  reason?: string | null;
};

export type TaskDetail = {
  attachments?: MediaAttachment[] | null;
  publishDefaults?: PublishDefaults | null;
  latestCheckpoint?: TaskCheckpointSummary | null;
  task: WorkspaceTask;
  messages: Message[];
  runs: Run[];
  jobs?: WorkspaceJob[] | null;
  events: WorkspaceEvent[];
  eventsTruncated?: boolean | null;
  eventsBefore?: number | null;
  cursor: number;
  activity?: TaskActivity[] | null;
  questions?: WorkspaceQuestion[] | null;
  queuedMessage?: QueuedMessage | null;
};

export type QueuedMessage = {
  attachmentIds?: string[] | null;
  taskId: string;
  content: string;
  status: string;
  reason?: string | null;
  createdAt: string;
};

export type WorkspaceQuestion = {
  id: string;
  taskId: string;
  runId: string;
  question: string;
  options: string[];
  status: string;
  answer?: string | null;
};

export type EventPage = {
  events: WorkspaceEvent[];
  cursor: number;
  supportsWait?: boolean | null;
};

export type TaskDiff = {
  truncated?: boolean | null;
  excluded?: string[] | null;
  hasUnpublishedChanges?: boolean | null;
  baselinePending?: boolean | null;
  baseRevision: string;
  headRevision: string;
  patch: string;
  status: string;
  files: ChangedFile[];
  checks: JSONValue[];
  scope?: string | null;
  note?: string | null;
  runId?: string | null;
};

export type ChangedFile = {
  path: string;
  status: string;
};

export type ControlTarget = {
  id: string;
  workerId: string;
  label: string;
  kind: string;
  available: boolean;
  reason?: string | null;
};

export type ControlSession = {
  targetId: string;
  viewOnly?: boolean | null;
  id: string;
  workerId: string;
  targetLabel: string;
  kind: string;
  status: string;
  generation: string;
  controlOwner?: string | null;
  reason?: string | null;
};

export type ControlCommand = {
  id: string;
  sessionId: string;
  status: string;
  error?: string | null;
};

export type ControlRequest = {
  id: string;
  workerId: string;
  targetLabel: string;
  kind: string;
  status: string;
};

export type ControlState = {
  requests?: ControlRequest[] | null;
  sessions: ControlSession[];
  targets: ControlTarget[];
  commands: ControlCommand[];
};

export type ControlSnapshot = {
  image?: string | null;
  text?: string | null;
  title?: string | null;
  width?: number | null;
  height?: number | null;
  inputBounds?: Record<string, number> | null;
  capturedAt: string;
};

export type BaseUpdate = {
  needsPublication?: boolean | null;
  status: string;
  targetBranch?: string | null;
  conflicts: string[];
  error?: string | null;
};

export type MediaAttachment = {
  id: string;
  taskId: string;
  runId?: string | null;
  messageId?: string | null;
  kind: string;
  mimeType: string;
  size: number;
  width?: number | null;
  height?: number | null;
  duration?: number | null;
  name: string;
  caption?: string | null;
  source: string;
  createdAt: string;
  preview?: string | null;
  jobId?: string | null;
};

export type WorkerBuild = {
  version: string;
  commit?: string | null;
};

export type WorkerUpdate = {
  state: string;
  reason: string;
  missingTools: string[];
};

export type NodePermissionStep = {
  where: string;
  label: string;
  command?: string | null;
  instruction?: string | null;
  action?: string | null;
};

export type CreateWorkspaceTaskRequest = {
  title: WorkspaceTask['title'];
  prompt: string;
  workerId: NonNullable<WorkspaceTask['workerId']>;
  operationId: string;
};
