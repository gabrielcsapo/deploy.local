'use client';

import { useEffect, useMemo, useState } from 'react';
import { getAuth, type Deployment } from './shared';

export interface ApplicationInstanceSelection {
  siteId?: string;
  component?: string;
  instanceId?: string;
}

interface RuntimeInstance {
  id: string;
  componentKey: string;
  slotKey: string;
  containerName: string;
  status: string;
  health: string;
}

interface RuntimeTargetInventory {
  siteId: string;
  execution: { componentOrder: string[] };
  actual: { instances: RuntimeInstance[] } | null;
}

export function ApplicationInstanceSelector({
  deployment,
  value,
  onChange,
}: {
  deployment: Deployment;
  value: ApplicationInstanceSelection;
  onChange: (selection: ApplicationInstanceSelection) => void;
}) {
  const [runtime, setRuntime] = useState<RuntimeTargetInventory | null>(null);
  const [siteDraft, setSiteDraft] = useState(
    value.siteId || deployment.activeNodeId || deployment.desiredNodeId || 'coordinator',
  );

  const siteId =
    value.siteId || deployment.activeNodeId || deployment.desiredNodeId || 'coordinator';

  useEffect(() => setSiteDraft(siteId), [siteId]);

  useEffect(() => {
    if (!deployment.appId || !deployment.activeSpecDigest) {
      setRuntime(null);
      return;
    }
    const auth = getAuth();
    if (!auth) return;
    const controller = new AbortController();
    const query = new URLSearchParams({ siteId });
    void fetch(
      `/api/deployments/${encodeURIComponent(deployment.name)}/application-runtime?${query}`,
      {
        headers: {
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Runtime target inventory is unavailable');
        return (await response.json()) as RuntimeTargetInventory;
      })
      .then(setRuntime)
      .catch((error) => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        setRuntime(null);
      });
    return () => controller.abort();
  }, [deployment.activeSpecDigest, deployment.appId, deployment.name, siteId]);

  const instances = useMemo(
    () =>
      (runtime?.actual?.instances ?? [])
        .filter(
          (instance) =>
            instance.status !== 'removed' &&
            instance.status !== 'failed' &&
            (!value.component || instance.componentKey === value.component),
        )
        .sort((left, right) =>
          `${left.componentKey}/${left.slotKey}/${left.id}`.localeCompare(
            `${right.componentKey}/${right.slotKey}/${right.id}`,
          ),
        ),
    [runtime, value.component],
  );

  if (!deployment.appId || !deployment.activeSpecDigest) return null;

  const components =
    runtime?.execution.componentOrder ?? (value.component ? [value.component] : []);

  const commitSite = () => {
    const nextSite = siteDraft.trim();
    if (!nextSite || nextSite === siteId) return;
    onChange({ siteId: nextSite, component: value.component });
  };

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1 rounded-md border border-border bg-bg/45 p-1 font-mono text-[11px]"
      aria-label="Runtime target"
    >
      <span className="px-1.5 text-[9px] uppercase tracking-[0.16em] text-text-tertiary">
        target
      </span>
      <TargetSeparator />
      <input
        value={siteDraft}
        onChange={(event) => setSiteDraft(event.target.value)}
        onBlur={commitSite}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitSite();
            event.currentTarget.blur();
          }
        }}
        className="min-h-[28px] w-28 rounded border-0 bg-transparent px-1.5 text-text outline-none focus:bg-bg-active focus:ring-1 focus:ring-accent"
        aria-label="Site id"
        title="Site id"
      />
      <TargetSeparator />
      <select
        value={value.component || ''}
        onChange={(event) =>
          onChange({
            siteId,
            component: event.target.value || undefined,
          })
        }
        className="min-h-[28px] max-w-40 rounded border-0 bg-transparent px-1.5 text-text outline-none focus:bg-bg-active focus:ring-1 focus:ring-accent"
        aria-label="Component"
      >
        <option value="">primary component</option>
        {components.map((component) => (
          <option key={component} value={component}>
            {component}
          </option>
        ))}
      </select>
      <TargetSeparator />
      <select
        value={value.instanceId || ''}
        onChange={(event) => {
          const instance = instances.find((candidate) => candidate.id === event.target.value);
          onChange({
            siteId,
            component: value.component || instance?.componentKey,
            instanceId: event.target.value || undefined,
          });
        }}
        className="min-h-[28px] max-w-56 rounded border-0 bg-transparent px-1.5 text-text outline-none focus:bg-bg-active focus:ring-1 focus:ring-accent"
        aria-label="Instance"
      >
        <option value="">ready instance</option>
        {instances.map((instance) => (
          <option key={instance.id} value={instance.id}>
            {instance.componentKey}/{instance.slotKey} · {instance.health}
          </option>
        ))}
      </select>
    </div>
  );
}

function TargetSeparator() {
  return (
    <span className="select-none text-border" aria-hidden="true">
      /
    </span>
  );
}
