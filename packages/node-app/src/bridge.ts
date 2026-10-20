import type { NodeStatus } from '../../../server/workspace/node-status.ts';
export type HelperAction = 'capture' | 'input' | 'lock-off' | 'lock-restore';
export type NodeSetupStatus = { node: NodeStatus; autostart: boolean };
export interface NodeBridge {
  status(): Promise<NodeSetupStatus>;
  enroll(url: string, code: string): Promise<void>;
  helper(action: HelperAction): Promise<void>;
  autostart(enabled: boolean): Promise<void>;
  permissions(): Promise<void>;
}

declare global {
  interface Window {
    deployNode?: NodeBridge;
  }
}
