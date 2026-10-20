export function browserInstallerCli(): string;
export function browserInstallProgress(line: string): string | null;
export function browserInstallFailure(output: string): string;
export function installChromium(options?: {
  cli?: string;
  executable?: string;
  browsersPath?: string;
  env?: NodeJS.ProcessEnv;
  onProgress?: (message: string) => void;
}): Promise<void>;
