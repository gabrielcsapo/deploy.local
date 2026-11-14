import type { WorkspaceDesignTool } from '../contracts/design-tool.ts';

let provider: WorkspaceDesignTool | undefined;

export function registerWorkspaceDesignTool(value: WorkspaceDesignTool) {
  provider = value;
}

export function requireWorkspaceDesignTool(processName: string): WorkspaceDesignTool {
  if (!provider) throw new Error(`WorkspaceDesignTool is not wired in ${processName}`);
  return provider;
}
