'use client';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Action, Icon } from '@/components/ui';
import {
  listenForUpdateDismissal,
  updateLabel,
  type DesktopUpdateApi,
  type DesktopUpdateStatus,
} from './data/desktop-update';

export function DesktopUpdateIcon({
  status,
  rail = false,
}: {
  status: DesktopUpdateStatus;
  rail?: boolean;
}) {
  const busy = ['downloading', 'checking', 'installing'].includes(status.phase);
  const failed = status.phase === 'failed';
  if (rail || status.phase === 'checking') {
    return (
      <span className="update-icon">
        <Icon name="download" size={16} />
        {(busy || failed) && (
          <span className="update-state-mark">
            <Icon
              name={failed ? 'attention' : 'running'}
              className={failed ? 'dl-del' : 'dl-run dl-spin'}
              size={10}
            />
          </span>
        )}
      </span>
    );
  }
  return (
    <Icon
      name={
        busy ? 'running' : failed ? 'attention' : status.phase === 'ready' ? 'check' : 'download'
      }
      className={busy ? 'dl-run dl-spin' : failed ? 'dl-del' : ''}
      size={16}
    />
  );
}

export function DesktopUpdateRow({
  api,
  status,
  open: controlledOpen,
  onOpenChange,
  popoverId,
  returnFocusRef,
}: {
  api?: DesktopUpdateApi;
  status: DesktopUpdateStatus;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  popoverId?: string;
  returnFocusRef?: RefObject<HTMLButtonElement | null>;
}) {
  const generatedId = useId();
  const id = popoverId ?? generatedId;
  const [localOpen, setLocalOpen] = useState(false);
  const open = Boolean(api && status.phase !== 'idle' && (controlledOpen ?? localOpen));
  const setOpen = onOpenChange ?? setLocalOpen;
  const boundary = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (open && !wasOpen.current) popover.current?.focus({ preventScroll: true });
    if (!open && wasOpen.current)
      (returnFocusRef?.current ?? trigger.current)?.focus({ preventScroll: true });
    wasOpen.current = open;
  }, [open, returnFocusRef]);
  useEffect(() => {
    if (!open || !boundary.current) return;
    return listenForUpdateDismissal(boundary.current, () => setOpen(false));
  }, [open, setOpen]);
  if (!api || status.phase === 'idle') return null;
  const { phase } = status;
  const invoke = (action: () => Promise<void>) => {
    void action().catch(console.error);
  };
  return (
    <section ref={boundary} className="dl-mac-update" aria-label="deploy.local for Mac update">
      <button
        ref={trigger}
        type="button"
        className={`dl-nav update-trigger${open ? ' on' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen(!open)}
      >
        <span className="dl-lead">
          <DesktopUpdateIcon status={status} />
        </span>
        <span className="dl-t">{updateLabel(status)}</span>
      </button>
      {open && (
        <div className="dl-mac-update-overlay">
          <div
            ref={popover}
            id={id}
            className="dl-menu dl-mac-update-popover"
            role="dialog"
            aria-labelledby={`${id}-heading`}
            tabIndex={-1}
          >
            <div className="update-product">
              <span id={`${id}-heading`} className="dl-strong">
                deploy.local for Mac
              </span>
              <span className="dl-meta">{status.commit?.slice(0, 7)}</span>
            </div>
            {phase === 'available' && (
              <>
                <p>Downloads in the background. You choose when to restart.</p>
                <div className="update-actions">
                  <Action variant="primary" onClick={() => invoke(api.start)}>
                    Download update
                  </Action>
                </div>
              </>
            )}
            {phase === 'downloading' && (
              <>
                <div className="dl-meta">
                  {Math.round((status.bytes ?? 0) / 1e6)} of {Math.round((status.total ?? 0) / 1e6)}{' '}
                  MB · {status.percent ?? 0}%
                </div>
                <progress
                  value={status.bytes ?? 0}
                  max={status.total || 1}
                  aria-label={`Downloading update: ${status.percent ?? 0} percent`}
                />
                <div className="update-actions">
                  <Action variant="quiet" onClick={() => invoke(api.cancel)}>
                    Cancel
                  </Action>
                </div>
              </>
            )}
            {(phase === 'checking' || phase === 'installing') && (
              <div className="update-status" role="status">
                <Icon name="running" className="dl-run dl-spin" size={16} />
                {updateLabel(status)}
              </div>
            )}
            {phase === 'ready' && (
              <>
                <p>Download checked. Restart reopens this page.</p>
                <div className="update-actions">
                  <Action variant="primary" onClick={() => invoke(api.restart)}>
                    Restart to update
                  </Action>
                  <Action onClick={() => setOpen(false)}>Later</Action>
                </div>
              </>
            )}
            {phase === 'installing' && <p>Reopening this page in a moment.</p>}
            {phase === 'failed' && (
              <>
                <p role="alert">
                  {status.error === 'verification'
                    ? 'The download did not match what deploy.local published; nothing was changed.'
                    : 'The download stopped. Nothing was changed.'}
                </p>
                <div className="update-actions">
                  <Action variant="primary" onClick={() => invoke(api.start)}>
                    Try again
                  </Action>
                  <Action variant="quiet" onClick={() => setOpen(false)}>
                    Dismiss
                  </Action>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
