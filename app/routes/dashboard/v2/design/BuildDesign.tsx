'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { Action } from '@/components/ui';
import type { DesignReview } from '../../../../../shared/v2/contracts';
import { getAuth } from '../../detail/shared';
import { useInbox } from '../data/hooks';
import { request } from '../projects/data';
import { buildPlace, canBuildDesign } from './review-model';
import './build-design.css';

/** The same owner action in the canvas and the original proposal card. */
export function BuildDesign({
  review,
  api,
  refresh,
  inChat = false,
}: {
  review: DesignReview;
  api: string;
  refresh: () => void;
  inChat?: boolean;
}) {
  const inbox = useInbox();
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const key = () => `deploy.design.buildPlace.${getAuth()?.username ?? ''}`;
  useEffect(() => {
    try {
      setSaved(localStorage.getItem(key()));
    } catch {
      /* Storage is optional. */
    }
  }, []);
  const place = buildPlace(review.proposerTaskId, inChat ? null : saved);
  if (!canBuildDesign(review) || requested) return null;
  async function build() {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await request(`${api}/review/build`, {
        method: 'POST',
        body: JSON.stringify({ item: review.id, place }),
      });
      setRequested(true);
      refresh();
      inbox.retry();
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <span className="dl-build-action">
      <span className="dl-build-split">
        <Action variant="primary" disabled={busy} onClick={() => void build()}>
          Build
        </Action>
        {!inChat && review.proposerTaskId && (
          <>
            <Action
              variant="primary"
              disabled={busy}
              aria-label="Where to build"
              aria-haspopup="menu"
              popoverTarget={menuId}
              aria-expanded={open}
              aria-controls={menuId}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                aria-hidden="true"
              >
                <path d="m6 9 6 6 6-6" />
              </svg>
            </Action>
            <div
              id={menuId}
              ref={menu}
              popover="auto"
              role="menu"
              aria-label="Where to build"
              className="ui-overflow-menu dl-build-menu"
              onToggle={(event) => {
                setOpen(event.newState === 'open');
                if (event.newState === 'open')
                  menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
              }}
              onKeyDown={(event) => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                event.preventDefault();
                const items = [...menu.current!.querySelectorAll<HTMLButtonElement>('button')];
                const at = items.indexOf(document.activeElement as HTMLButtonElement);
                items[
                  event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (at + 1) % items.length
                ]?.focus();
              }}
            >
              {(['proposer', 'new'] as const).map((value) => (
                <Action
                  key={value}
                  role="menuitemradio"
                  aria-checked={place === value}
                  onClick={() => {
                    setSaved(value);
                    try {
                      localStorage.setItem(key(), value);
                    } catch {
                      /* Storage is optional. */
                    }
                    menu.current?.hidePopover();
                  }}
                >
                  <span>
                    <b>
                      {value === 'proposer' ? `In ${review.proposer.name}’s task` : 'In a new task'}
                    </b>
                    <span className="dl-meta">
                      {value === 'proposer'
                        ? 'Carries on the conversation that proposed it'
                        : 'Starts a task that builds this design'}
                    </span>
                  </span>
                  {place === value && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      aria-hidden="true"
                    >
                      <path d="m5 12 5 5 9-10" />
                    </svg>
                  )}
                </Action>
              ))}
            </div>
          </>
        )}
      </span>
      {error && (
        <span className="dl-meta" role="alert">
          {error}
        </span>
      )}
    </span>
  );
}
