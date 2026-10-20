export type AgentConfig = {
  coordinatorUrl: string;
  nodeId: string;
  name: string;
  secret: string;
  workerId?: string;
  workerToken?: string;
};
export function userAgentConfigPath(env?: NodeJS.ProcessEnv, home?: string): string;
export function agentConfigPath(): string;
export function readAgentConfig(path?: string): AgentConfig | null;
export function joinAgent(options: {
  coordinatorUrl: string;
  code: string;
  name?: string;
  capabilities?: Record<string, unknown>;
  version?: string;
  taskWorker?: boolean;
  roles?: Partial<Record<'deploy' | 'tasks' | 'computer' | 'browser', boolean>>;
  configPath?: string;
  request?: (url: string, options: RequestInit) => Promise<Response>;
}): Promise<AgentConfig>;
