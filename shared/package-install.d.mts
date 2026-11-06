export type InstallConfig = {
  registry: string;
  key: string;
  ca: string;
  address?: string;
  fallbackRegistry?: string;
};
export type PreparedInstall = {
  env: NodeJS.ProcessEnv;
  args: string[];
  key: string;
  secrets: string[];
  npmrc?: string;
  ca?: string;
  directory?: string;
  cleanup(): Promise<void>;
};
export const registryFallback: string;
export function registryPing(config: InstallConfig, timeout?: number): Promise<boolean>;
export function projectRegistry(cwd: string): Promise<boolean>;
export function preparePackageInstall(
  config: InstallConfig | null,
  options: {
    cwd: string;
    root: string;
    container?: boolean;
    environment?: NodeJS.ProcessEnv;
    log?: (line: string) => void;
    ping?: typeof registryPing;
  },
): Promise<PreparedInstall>;
export function secretOutput(
  secrets: string[],
  append: (text: string) => void,
): { write(chunk: Buffer | string): void; end(): void };
