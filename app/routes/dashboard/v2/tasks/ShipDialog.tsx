'use client';
import { useState } from 'react';
import { Action, Banner, Dialog, Group, Seg, Setting, Steps } from '@/components/ui';
import type { Release } from '../../../../../shared/v2/contracts';
import { authenticatedFetch } from '../data/hooks';
import { ReleaseProgress } from '../conversation/Conversation';
import { shipProject } from './api';
import type { TaskView } from './types';

export function ShipDialog({
  open,
  onClose,
  view,
  release,
  onRelease,
}: {
  open: boolean;
  onClose: () => void;
  view: TaskView;
  release?: Release;
  onRelease: (release: Release) => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const ref = view.ship?.ref;
  async function ship() {
    if (pending || !view.project || !ref) return;
    setPending(true);
    setError('');
    try {
      onRelease(await shipProject(authenticatedFetch, view.project.id, ref));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Shipping could not start.');
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      className="dl-ship-dialog"
      open={open}
      onClose={onClose}
      title={`Ship ${view.project?.name.replaceAll('-', ' ') || view.task.title}`}
      actions={
        <>
          <Action variant="quiet" onClick={onClose}>
            {release ? 'Close' : 'Cancel'}
          </Action>
          {!release && (
            <Action
              variant="primary"
              loading={pending}
              disabled={!view.project || !ref}
              onClick={() => void ship()}
            >
              Ship
            </Action>
          )}
        </>
      }
    >
      {release ? (
        <ReleaseProgress release={release} />
      ) : (
        <>
          <p className="dl-soft">
            {view.releases.length ? 'A new release' : 'The first release'} of {view.project?.name}.
            After this, changes arrive as pull requests you merge.
          </p>
          <Group>
            <div className="dl-inset">
              <Setting label="Runs on">
                {view.ship?.runsOn || 'Unavailable · uses project configuration'}
              </Setting>
              <Setting label="Address">
                {view.ship?.address || 'Unavailable · uses project configuration'}
              </Setting>
              <Setting label="Who can open it">
                {view.ship?.access ? (
                  <div title="This release uses the project's saved access setting.">
                    <Seg
                      label="Who can open it"
                      value={view.ship.access}
                      options={[
                        { value: 'Just me', label: 'Just me' },
                        { value: 'Everyone at home', label: 'Everyone at home' },
                      ]}
                      disabled
                      onChange={() => {}}
                    />
                  </div>
                ) : (
                  'Unavailable · uses project configuration'
                )}
              </Setting>
              <Setting label="Data" description={view.ship?.data}>
                {view.ship?.data
                  ? 'Project configuration'
                  : 'Unavailable · uses project configuration'}
              </Setting>
            </div>
          </Group>
          <Steps
            steps={[
              {
                icon: 'cloud',
                text: `Prepare the release from ${ref || 'an unavailable revision'}`,
              },
              { icon: 'check', text: 'Verify it on a copy, then switch' },
              { icon: 'pulse', text: 'Watch the release for 10 minutes' },
            ]}
          />
          {!ref && <Banner title="Publish a source revision before shipping." />}
          {error && <Banner kind="danger" title={error} />}
        </>
      )}
    </Dialog>
  );
}
