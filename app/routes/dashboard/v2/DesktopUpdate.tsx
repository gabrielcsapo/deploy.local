'use client';
import { Action, Icon } from '@/components/ui';
import {
  updateLabel,
  type DesktopUpdateApi,
  type DesktopUpdateStatus,
} from './data/desktop-update';

export function DesktopUpdateRow({
  api,
  status,
}: {
  api?: DesktopUpdateApi;
  status: DesktopUpdateStatus;
}) {
  if (!api || status.phase === 'idle') return null;
  const { phase } = status;
  const product = (
    <span className="update-meta">deploy.local for Mac · {status.commit?.slice(0, 7)}</span>
  );
  const invoke = (action: () => Promise<void>) => {
    void action().catch(console.error);
  };
  return (
    <section className="dl-mac-update" aria-label="deploy.local for Mac update">
      {phase === 'available' || phase === 'ready' ? (
        <button
          type="button"
          className="update-action"
          onClick={() => invoke(phase === 'ready' ? api.restart : api.start)}
        >
          <span className="update-title">{updateLabel(status)}</span>
          {product}
        </button>
      ) : (
        <>
          <div
            className={`update-title${phase === 'installing' ? ' installing' : ''}`}
            role="status"
          >
            {phase === 'installing' && <Icon name="running" className="dl-run dl-spin" size={14} />}
            {updateLabel(status)}
          </div>
          {product}
        </>
      )}
      {phase === 'downloading' && (
        <>
          <progress
            value={status.bytes ?? 0}
            max={status.total || 1}
            aria-label="Downloading update"
          />
          <div className="update-line">
            <span className="update-meta">
              {Math.round((status.bytes ?? 0) / 1e6)} of {Math.round((status.total ?? 0) / 1e6)} MB
            </span>
            <Action variant="quiet" onClick={() => invoke(api.cancel)}>
              Cancel
            </Action>
          </div>
        </>
      )}
      {phase === 'ready' && <p>Download checked. Reopens this page.</p>}
      {phase === 'installing' && <p>Reopening this page in a moment.</p>}
      {phase === 'failed' && (
        <>
          <p role="alert">
            {status.error === 'verification'
              ? 'The download did not match what deploy.local published; nothing was changed.'
              : 'The download stopped. Nothing was changed.'}
          </p>
          <Action variant="quiet" onClick={() => invoke(api.start)}>
            Try again
          </Action>
        </>
      )}
    </section>
  );
}
