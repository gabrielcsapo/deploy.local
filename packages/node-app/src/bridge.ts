import type { NodeStatus } from '../../../server/workspace/node-status.ts';
export type HelperAction =
  | 'capture'
  | 'capture-stop'
  | 'input'
  | 'input-stop'
  | 'lock-off'
  | 'lock-restore'
  | 'browser';
export type BrowserInstallStatus = { busy: boolean; message: string; error?: string };
export type NodeSetupStatus = {
  node: NodeStatus;
  autostart: boolean;
  browserInstall: BrowserInstallStatus;
};

export interface NodeBridge {
  status(): Promise<NodeSetupStatus>;
  enroll(url: string, code: string): Promise<void>;
  helper(action: HelperAction): Promise<void>;
  autostart(enabled: boolean): Promise<void>;
  permissions(): Promise<void>;
  onBrowserInstall(listener: (status: BrowserInstallStatus) => void): () => void;
}

declare global {
  interface Window {
    deployNode?: NodeBridge;
  }
}
