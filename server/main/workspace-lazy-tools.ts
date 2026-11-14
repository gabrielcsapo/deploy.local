import { registerMergePermissionSource } from '../workspace/merge-permission-port.ts';
import { registerWorkspaceDesignTool } from '../workspace/design-tool-port.ts';

/** Registration is inert: preserve the import at the original tool call, including denied merges. */
export function wireWorkspaceLazyTools() {
  registerMergePermissionSource(async () => (await import('../v2/releases.ts')).isAllowed);
  registerWorkspaceDesignTool(async (scope, args) =>
    (await import('../v2/design.ts')).designTool(scope, args),
  );
}
