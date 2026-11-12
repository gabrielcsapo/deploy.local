'use client';
import { useEffect, useState } from 'react';
import { Action, Banner, ChipSelect, Dialog, Group, Seg, Setting, Steps } from '@/components/ui';
import type { Release } from '../../../../../shared/v2/contracts';
import { authenticatedFetch } from '../data/hooks';
import { ReleaseProgress } from '../conversation/Conversation';
import type { ShipPlan } from '../../../../../server/v2/releases-plan';
import { requestJson, shipProject } from './api';
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
  const projectId = view.project?.id;
  const [plan, setPlan] = useState<ShipPlan>();
  useEffect(() => {
    if (!open || release || !projectId) return;
    const controller = new AbortController();
    setPlan(undefined);
    setError('');
    void requestJson<{ plan: ShipPlan }>(
      authenticatedFetch,
      `/api/v2/projects/${encodeURIComponent(projectId)}/releases/plan`,
      { method: 'POST', signal: controller.signal },
    )
      .then(({ plan }) => setPlan(plan))
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason.message);
      });
    return () => controller.abort();
  }, [open, release, projectId]);
  function choose(appId: string, patch: Partial<ShipPlan['apps'][number]>) {
    setPlan(
      (current) =>
        current && {
          ...current,
          apps: current.apps.map((app) => (app.appId === appId ? { ...app, ...patch } : app)),
        },
    );
  }
  async function ship() {
    if (pending || !view.project || !ref || !plan) return;
    setPending(true);
    setError('');
    try {
      onRelease(await shipProject(authenticatedFetch, view.project.id, ref, { apps: plan.apps }));
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
              disabled={!view.project || !ref || !plan || !plan.computers.length}
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
          {!plan && !error && <p role="status">Loading release choices…</p>}
          {plan?.apps.map((app) => (
            <Group key={app.appId}>
              <div className="dl-inset">
                {plan.apps.length > 1 && <p>{app.appId}</p>}
                <Setting label="Runs on" description="Run apps">
                  <ChipSelect
                    label={`Runs on · ${app.appId}`}
                    value={app.computerId}
                    disabled={pending}
                    onChange={(value) => choose(app.appId, { computerId: value })}
                    options={plan.computers.map((computer) => ({
                      value: computer.id,
                      label: computer.name,
                    }))}
                  />
                </Setting>
                <Setting label="Address" description="A local address">
                  <div className="dl-field">
                    <input
                      aria-label={`Address · ${app.appId}`}
                      value={app.address}
                      disabled={pending}
                      onChange={(event) => choose(app.appId, { address: event.target.value })}
                    />
                  </div>
                </Setting>
                <Setting label="Who can open it">
                  <Seg
                    label={`Who can open it · ${app.appId}`}
                    value={app.visibility}
                    options={[
                      { value: 'private', label: 'Just me' },
                      { value: 'home', label: 'Everyone at home' },
                    ]}
                    disabled={pending}
                    onChange={(value) =>
                      choose(app.appId, { visibility: value as 'private' | 'home' })
                    }
                  />
                </Setting>
                <Setting label="Data" description="Verify on a copy before switching">
                  <ChipSelect
                    label={`Data · ${app.appId}`}
                    value={app.data}
                    disabled={pending}
                    onChange={(value) => choose(app.appId, { data: value as 'keep' | 'new' })}
                    options={[
                      { value: 'keep', label: 'Keep existing data' },
                      { value: 'new', label: 'New data' },
                    ]}
                  />
                </Setting>
              </div>
            </Group>
          ))}
          {plan && !plan.computers.length && <Banner title="No online computers have Run apps." />}
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
