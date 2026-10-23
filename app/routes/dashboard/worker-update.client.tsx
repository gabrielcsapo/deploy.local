'use client';
import { StatusBadge } from '../../components/ui';
import type { WorkerUpdate } from '../../../server/workspace/worker-update';

export function WorkerUpdateWarning({ update }: { update?: WorkerUpdate }) {
  if (!update || update.state === 'current') return null;
  return (
    <span title={update.reason} role="status">
      <StatusBadge
        className="pw-worker-update-warning"
        tone="attention"
        label="Older worker: agents can't commit or deploy here"
      />
    </span>
  );
}

export function WorkerUpdateNotice({
  update,
  platform,
}: {
  update?: WorkerUpdate;
  platform: string;
}) {
  if (!update || update.state === 'current') return null;
  return (
    <aside className="pw-risk-notice" aria-label="Worker update available">
      <StatusBadge tone="attention" label="Update available" />
      <p>{update.reason}</p>
      <p>
        {platform === 'darwin'
          ? 'Install the latest deploy.local worker on this Mac, then restart its worker service.'
          : 'Install the latest deploy.local worker on this computer.'}
      </p>
      {platform === 'linux' && (
        <p>
          For deploy.local Node, install the latest .deb or replace the AppImage in its existing
          location, then quit and reopen Node.
        </p>
      )}
    </aside>
  );
}
