'use client';
import { useState } from 'react';
import { Action, Banner, Dialog, Icon, Skeleton } from '@/components/ui';
import { request, useData } from './data';
import { useProjectFormatting } from './formatting.ts';
import { remoteHostName } from './default-branch.ts';
import './default-branch.css';

// "Just now" and "Yesterday" start a sentence; after "last commit" they are lowercase.
const midSentence = (time: string) =>
  /^(Just now|Yesterday|Today)/.test(time) ? time[0].toLowerCase() + time.slice(1) : time;

type Branches = {
  defaultBranch: string;
  branches: { name: string; commit: string; committedAt: string | null }[];
};

/** Pick which existing branch tasks start from and merge into, and releases come from. */
export function DefaultBranchDialog({
  open,
  onClose,
  base,
  remote,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  /** The project's /api/projects/<id>/repository path. */
  base: string;
  /** The remote's address, when the project has one. */
  remote?: string | null;
  onChanged: () => void;
}) {
  const { formatTime } = useProjectFormatting();
  const listed = useData<Branches>(open ? `${base}/branches` : undefined);
  const current = listed.data?.defaultBranch;
  const [chosen, setChosen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pick = chosen || current || '';
  const changing = !!current && pick !== current;
  const host = remote ? remoteHostName(remote) : null;
  // Each opening starts from the current default with no error.
  const close = () => {
    if (busy) return;
    setChosen('');
    setError('');
    onClose();
  };
  return (
    <Dialog
      open={open}
      onClose={close}
      title="Default branch"
      className="v2-default-branch-dialog"
      actions={
        <>
          <Action variant="quiet" disabled={busy} onClick={close}>
            Cancel
          </Action>
          <Action
            variant="primary"
            disabled={!changing}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await request(`${base}/default-branch`, {
                  method: 'POST',
                  body: JSON.stringify({ operationId: crypto.randomUUID(), branch: pick }),
                });
                onChanged();
                setChosen('');
                onClose();
              } catch (reason) {
                setError((reason as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {pick ? `Use ${pick}` : 'Use branch'}
          </Action>
        </>
      }
    >
      <p className="dl-meta v2-default-branch-intro">
        Tasks start from it and merge into it, and merges to it become releases.
      </p>
      {error && <Banner kind="danger" title={error} />}
      {listed.error && !listed.data ? (
        <Banner
          kind="danger"
          title="Branches are unavailable"
          action={<Action onClick={listed.refresh}>Retry</Action>}
        />
      ) : (
        <div className="dl-group v2-default-branch-list" role="listbox" aria-label="Branches">
          <div className="dl-inset">
            {!listed.data && <Skeleton rows={3} />}
            {listed.data?.branches.map((branch) => {
              const selected = branch.name === pick;
              const when = branch.committedAt
                ? `last commit ${midSentence(formatTime(branch.committedAt))}`
                : '';
              return (
                <button
                  key={branch.name}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  className="dl-item v2-default-branch-option"
                  disabled={busy}
                  onClick={() => setChosen(branch.name)}
                >
                  <span className="dl-t">
                    <span className="dl-mono">{branch.name}</span>
                    <span>
                      {branch.name === current
                        ? ['Default now', when].filter(Boolean).join(' · ')
                        : when.replace(/^l/, 'L')}
                    </span>
                  </span>
                  <span className="dl-v v2-default-branch-mark">
                    {selected && <Icon name="tick" size={16} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {changing && (
        <p className="dl-meta v2-default-branch-note">
          Changing it releases nothing. The next merge to {pick} does. {current} stays as it is
          {remote
            ? `, and the remote${host ? ` on ${host}` : ''} keeps its own default branch.`
            : '.'}
        </p>
      )}
    </Dialog>
  );
}
