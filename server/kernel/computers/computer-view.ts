import { isDeepStrictEqual } from 'node:util';
import { materialized } from '../materialized.ts';
import { onNodeChange } from './nodes.ts';
import { onRecordChange } from '../db/records.ts';
import { namedDatabase } from '../db/named-store.ts';

/** Dependencies shared by computer inventory and worker role policy. */
export function computerView<V>(compute: (owner: string) => V, cadenceMs: number) {
  const view = materialized(compute, { cadenceMs });
  onNodeChange(() => view.invalidate()); // Nodes and role preferences are fleet-wide.
  onRecordChange(
    [
      'worker',
      'interactive-worker',
      'managed-worker',
      'project',
      'worker-inventory',
      'v2-computer-roles',
      'terminal-permission',
      'tool-probe',
      'v2-update-reservation',
    ],
    (owner, kind, row, previous) => {
      const relevant = (value: any) => {
        if (!value) return value;
        if (kind === 'project')
          return { name: value.name, autoApproveTaskBrowser: value.autoApproveTaskBrowser };
        if (kind === 'worker' || kind === 'interactive-worker') {
          const { heartbeat: _, ...inventory } = value;
          return inventory;
        }
        return value;
      };
      if (isDeepStrictEqual(relevant(row), relevant(previous))) return;
      if (owner === 'system') view.invalidate();
      else view.invalidate(owner);
    },
  );
  return {
    ...view,
    read: (owner: string) => view.read(owner, !namedDatabase('workspace').inTransaction),
  };
}
