'use client';

import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { stringify } from 'yaml';
import type {
  ApplicationChangeAction,
  ApplicationChangePlan,
} from '../../../../server/application-plan.ts';
import type { ApplicationSpec } from '../../../../server/application-spec.ts';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { DownloadIcon } from '../../../components/dashboard/icons';
import { useToast } from '../../../components/Toaster';
import { getAuth } from './shared';
import { StructuredGraphEditor } from './StructuredGraphEditor';

interface RevisionSummary {
  digest: string;
  parentDigest: string | null;
  apiVersion: string;
  source: string;
  manifestFormat: string;
  createdBy: string | null;
  createdAt: string;
  active: boolean;
}

interface ApplicationSpecResponse {
  desiredDigest: string | null;
  activeDigest: string | null;
  source: string | null;
  sourceAligned: boolean;
  notYetInSource: boolean;
  desired: ApplicationSpec | null;
  revisions: RevisionSummary[];
}

type ConfigurationDeclarationView = ApplicationSpec['configuration'][string] & {
  configured: boolean;
  revision: number;
  updatedAt: string | null;
};

interface ConfigurationResponse {
  siteId: string;
  ready: boolean;
  missing: string[];
  configurationDigest: string;
  declarations: Record<string, ConfigurationDeclarationView>;
}

interface ApplicationPlanResponse {
  parentDigest: string;
  candidateDigest: string;
  plan: ApplicationChangePlan;
  normalized: ApplicationSpec;
  manifest: string;
}

interface ApiErrorBody {
  error?: string;
  expectedParentDigest?: string | null;
  plan?: ApplicationChangePlan;
}

type ConfigurationValue = string | number | boolean;

export function ApplicationGraphPanel({ name }: { name: string }) {
  const titleId = useId();
  const { toast } = useToast();
  const [specState, setSpecState] = useState<ApplicationSpecResponse | null>(null);
  const [configuration, setConfiguration] = useState<ConfigurationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [configurationError, setConfigurationError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [copyingPatch, setCopyingPatch] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmingApply, setConfirmingApply] = useState(false);

  const fetchGraph = useCallback(
    async (background = false) => {
      const auth = getAuth();
      if (!auth) {
        setError('Authenticate again to inspect this application graph.');
        setLoading(false);
        return;
      }

      if (!background) setLoading(true);
      setError('');
      setConfigurationError('');
      try {
        const headers = {
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        };
        const [specResponse, configurationResponse] = await Promise.all([
          fetch(`/api/deployments/${encodeURIComponent(name)}/application-spec`, { headers }),
          fetch(`/api/deployments/${encodeURIComponent(name)}/configuration`, { headers }),
        ]);
        if (!specResponse.ok) {
          throw new Error(await responseError(specResponse, 'Application graph is unavailable'));
        }
        const nextSpecState = (await specResponse.json()) as ApplicationSpecResponse;
        setSpecState(nextSpecState);

        if (configurationResponse.ok) {
          setConfiguration((await configurationResponse.json()) as ConfigurationResponse);
        } else {
          setConfiguration(null);
          setConfigurationError(
            await responseError(configurationResponse, 'Configuration readiness is unavailable'),
          );
        }
      } catch (fetchError) {
        setSpecState(null);
        setConfiguration(null);
        setError((fetchError as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [name],
  );

  useEffect(() => {
    void fetchGraph();
  }, [fetchGraph]);

  const refreshConfiguration = useCallback(
    async (siteId: string) => {
      const auth = getAuth();
      if (!auth) throw new Error('Authenticate again to manage application configuration.');
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/configuration?siteId=${encodeURIComponent(siteId)}`,
        {
          headers: {
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
        },
      );
      if (!response.ok) {
        throw new Error(await responseError(response, 'Unable to refresh configuration readiness'));
      }
      const nextConfiguration = (await response.json()) as ConfigurationResponse;
      setConfiguration(nextConfiguration);
      setConfigurationError('');
      return nextConfiguration;
    },
    [name],
  );

  async function saveConfigurationValue(key: string, value: ConfigurationValue) {
    const auth = getAuth();
    if (!auth) throw new Error('Authenticate again to manage application configuration.');
    if (!configuration) throw new Error('Configuration readiness is unavailable.');

    const response = await fetch(
      `/api/deployments/${encodeURIComponent(name)}/configuration/${encodeURIComponent(key)}?siteId=${encodeURIComponent(configuration.siteId)}`,
      {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
        body: JSON.stringify({ value, siteId: configuration.siteId }),
      },
    );
    if (!response.ok) {
      throw new Error(await responseError(response, `Unable to save ${key}`));
    }

    const nextConfiguration = await refreshConfiguration(configuration.siteId);
    toast(`configuration-${name}-${key}`, {
      type: 'success',
      title: `${key} saved`,
      description: nextConfiguration.ready
        ? `Configuration is ready on ${nextConfiguration.siteId}. A running application may need to be restarted.`
        : `${nextConfiguration.missing.length} required value${nextConfiguration.missing.length === 1 ? '' : 's'} still missing on ${nextConfiguration.siteId}.`,
    });
  }

  async function exportDeployYaml() {
    const auth = getAuth();
    if (!auth) return;
    setExporting(true);
    try {
      const response = await fetch(`/api/deployments/${encodeURIComponent(name)}/deploy.yaml`, {
        headers: {
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
      });
      if (!response.ok) {
        throw new Error(await responseError(response, 'Unable to export deploy.yaml'));
      }
      const blobUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      const disposition = response.headers.get('content-disposition');
      link.href = blobUrl;
      link.download = disposition?.match(/filename="([^"]+)"/)?.[1] ?? `${name}-deploy.yaml`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(blobUrl);
      toast(`deploy-yaml-${name}`, {
        type: 'success',
        title: 'deploy.yaml exported',
        description: 'Commit this durable application graph to the project repository.',
      });
    } catch (exportError) {
      toast(`deploy-yaml-${name}`, {
        type: 'error',
        title: 'Export failed',
        description: (exportError as Error).message,
      });
    } finally {
      setExporting(false);
    }
  }

  async function copyParentPatch() {
    const auth = getAuth();
    if (!auth) return;
    setCopyingPatch(true);
    try {
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/deploy.patch.yaml`,
        {
          headers: {
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
        },
      );
      if (!response.ok) {
        throw new Error(await responseError(response, 'Unable to export the parent patch'));
      }
      await navigator.clipboard.writeText(await response.text());
      toast(`deploy-patch-${name}`, {
        type: 'success',
        title: 'Parent-relative patch copied',
        description:
          'Apply this reviewable patch to the declared parent revision in the repository.',
      });
    } catch (copyError) {
      toast(`deploy-patch-${name}`, {
        type: 'error',
        title: 'Patch copy failed',
        description: (copyError as Error).message,
      });
    } finally {
      setCopyingPatch(false);
    }
  }

  async function applyDesiredRevision(confirmDestructive = false) {
    const auth = getAuth();
    if (!auth || !specState?.desiredDigest) return;
    setApplying(true);
    setConfirmingApply(false);
    setError('');
    try {
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/application-apply`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({
            expectedDesiredDigest: specState.desiredDigest,
            confirmDestructive,
          }),
        },
      );
      const body = (await response.json()) as ApiErrorBody & {
        applied?: boolean;
        activeDigest?: string;
      };
      if (!response.ok) {
        if (response.status === 409 && body.plan?.destructive && !confirmDestructive) {
          setConfirmingApply(true);
          return;
        }
        throw new Error(body.error || 'Unable to apply the desired application graph');
      }
      toast(`application-apply-${name}`, {
        type: 'success',
        title: 'Application graph active',
        description: 'The target-local runtime passed health admission before traffic activation.',
      });
      await fetchGraph(true);
    } catch (applyError) {
      setError((applyError as Error).message);
    } finally {
      setApplying(false);
    }
  }

  if (loading) return <GraphLoading />;

  if (error || !specState?.desired) {
    return (
      <section className="card p-4 sm:p-5" aria-labelledby={titleId}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="eyebrow">Application definition</p>
            <h2 id={titleId} className="mt-1 text-base font-semibold">
              Application graph unavailable
            </h2>
            <p className="mt-1 text-xs text-text-secondary">
              {error || 'This application does not have a desired graph revision yet.'}
            </p>
          </div>
          <button type="button" className="btn btn-sm text-xs" onClick={() => void fetchGraph()}>
            Retry
          </button>
        </div>
      </section>
    );
  }

  const spec = specState.desired;
  const desiredRevision = specState.revisions.find(
    (revision) => revision.digest === specState.desiredDigest,
  );
  const activeRevision = specState.revisions.find(
    (revision) => revision.digest === specState.activeDigest,
  );
  const revisionAligned =
    Boolean(specState.desiredDigest) && specState.desiredDigest === specState.activeDigest;

  return (
    <section className="card overflow-hidden" aria-labelledby={titleId}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="eyebrow">Application definition</p>
            <span className="badge badge-accent">{spec.apiVersion}</span>
            <span className={`badge ${revisionAligned ? 'badge-success' : 'badge-warning'}`}>
              {revisionAligned ? 'Active revision matches' : 'Activation pending'}
            </span>
            <span
              className={`badge ${specState.sourceAligned ? 'badge-success' : 'badge-warning'}`}
            >
              {specState.sourceAligned ? 'In source' : 'Not yet in source'}
            </span>
          </div>
          <h2 id={titleId} className="mt-1.5 text-base font-semibold text-text">
            Desired application graph
          </h2>
          <p className="mt-1 text-xs text-text-secondary">
            The database indexes this immutable revision; deploy.yaml remains its portable copy.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!revisionAligned && (
            <button
              type="button"
              className="btn btn-primary btn-sm text-xs"
              onClick={() => void applyDesiredRevision()}
              disabled={applying || !configuration?.ready}
              title={
                configuration?.ready
                  ? 'Converge and health-gate this desired revision on the local site'
                  : 'Resolve required configuration before applying'
              }
            >
              {applying ? 'Applying…' : 'Apply desired revision'}
            </button>
          )}
          <a href="#application-graph-editor" className="btn btn-primary btn-sm text-xs">
            Edit graph
          </a>
          <button
            type="button"
            className="btn btn-sm shrink-0 text-xs"
            onClick={() => void exportDeployYaml()}
            disabled={exporting}
          >
            <DownloadIcon className="h-3.5 w-3.5" />
            {exporting ? 'Exporting…' : 'Export deploy.yaml'}
          </button>
          <button
            type="button"
            className="btn btn-sm shrink-0 text-xs"
            onClick={() => void copyParentPatch()}
            disabled={copyingPatch}
          >
            {copyingPatch ? 'Copying…' : 'Copy parent patch'}
          </button>
        </div>
      </header>

      <div className="space-y-5 p-4 sm:p-5">
        <div className="grid grid-cols-1 items-stretch gap-2 md:grid-cols-[minmax(0,1fr)_2rem_minmax(0,1fr)]">
          <RevisionCard
            label="Desired"
            digest={specState.desiredDigest}
            source={desiredRevision?.source ?? specState.source}
            manifestFormat={desiredRevision?.manifestFormat}
            timestamp={desiredRevision?.createdAt}
            tone={revisionAligned ? 'success' : 'accent'}
          />
          <div className="flex items-center justify-center text-text-tertiary" aria-hidden="true">
            <span className="md:hidden">↓</span>
            <span className="hidden md:inline">→</span>
          </div>
          <RevisionCard
            label="Active"
            digest={specState.activeDigest}
            source={activeRevision?.source}
            manifestFormat={activeRevision?.manifestFormat}
            timestamp={activeRevision?.createdAt}
            tone={revisionAligned ? 'success' : 'warning'}
          />
        </div>

        <div className="flex flex-wrap gap-2 text-[11px] font-mono text-text-secondary">
          <GraphCount count={Object.keys(spec.components).length} singular="component" />
          <GraphCount count={Object.keys(spec.resources).length} singular="resource" />
          <GraphCount count={Object.keys(spec.routes).length} singular="route" />
          <GraphCount count={Object.keys(spec.jobs).length} singular="job" />
        </div>

        <GraphSection title="Components" empty="No runnable components declared.">
          {sortedEntries(spec.components).map(([key, component]) => (
            <li key={key} className="px-3 py-3 sm:px-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold text-text">
                  {component.displayName ?? key}
                </span>
                {component.displayName && (
                  <code className="text-[10px] text-text-tertiary">{key}</code>
                )}
                <span className="badge bg-bg-active text-text-secondary ring-1 ring-border">
                  {component.role}
                </span>
                <span className="badge badge-accent">
                  {component.instances} {component.instances === 1 ? 'instance' : 'instances'}
                </span>
                <span className="badge bg-bg-active text-text-secondary ring-1 ring-border">
                  min {component.minimumReady} · {component.rollout.strategy}
                </span>
                {component.profile && <span className="badge badge-success">profiled</span>}
              </div>
              <p className="mt-1.5 break-all font-mono text-[11px] text-text-secondary">
                {component.image ?? buildLabel(component.build)}
              </p>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
                {sortedEntries(component.interfaces).map(([interfaceName, item]) => (
                  <span key={interfaceName} className="font-mono">
                    {interfaceName} · {item.protocol}:{item.port}
                  </span>
                ))}
                {component.dependsOn.length > 0 && (
                  <span>Depends on {component.dependsOn.join(', ')}</span>
                )}
                {Object.keys(component.mounts).length > 0 && (
                  <span>
                    {Object.keys(component.mounts).length}{' '}
                    {Object.keys(component.mounts).length === 1 ? 'mount' : 'mounts'}
                  </span>
                )}
                <span>
                  {component.placement.intent === 'spread'
                    ? 'Spread across nodes'
                    : 'Keep together'}
                </span>
                {component.capacity.memoryBytes && (
                  <span>{formatBytes(component.capacity.memoryBytes)} RAM each</span>
                )}
                {component.siteOverrides.allowed && (
                  <span>
                    Site counts {component.siteOverrides.minimum}–{component.siteOverrides.maximum}
                  </span>
                )}
              </div>
            </li>
          ))}
        </GraphSection>

        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <GraphSection title="Resources" empty="No persistent resources declared.">
            {sortedEntries(spec.resources).map(([key, resource]) => (
              <li key={key} className="px-3 py-3">
                <p className="truncate text-xs font-semibold text-text" title={key}>
                  {resource.displayName ?? key}
                  {resource.displayName && (
                    <code className="ml-1.5 text-[9px] text-text-tertiary">{key}</code>
                  )}
                </p>
                <p className="mt-1 text-[11px] text-text-secondary">
                  {resource.durability} {resource.dataRole} · {resource.access}
                </p>
                <p className="mt-1 text-[10px] text-text-tertiary">
                  group {resource.consistencyGroup} · {resource.ownership} · backup{' '}
                  {resource.backup.policy}
                </p>
              </li>
            ))}
          </GraphSection>

          <GraphSection title="Routes" empty="No public routes declared.">
            {sortedEntries(spec.routes).map(([key, route]) => (
              <li key={key} className="px-3 py-3">
                <div className="flex items-center justify-between gap-2">
                  <code className="truncate text-xs font-semibold text-text" title={key}>
                    {key}
                  </code>
                  <span className="badge badge-accent">{route.to}</span>
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-text-secondary">
                  {route.hostname ?? 'generated hostname'}
                  {route.path}
                </p>
              </li>
            ))}
          </GraphSection>

          <GraphSection title="Jobs" empty="No lifecycle jobs declared.">
            {sortedEntries(spec.jobs).map(([key, job]) => (
              <li key={key} className="px-3 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <code className="text-xs font-semibold text-text">{key}</code>
                  <span className="badge bg-bg-active text-text-secondary ring-1 ring-border">
                    {job.execution}
                  </span>
                  {job.beforeTraffic && <span className="badge badge-warning">before traffic</span>}
                </div>
                <p className="mt-1 truncate font-mono text-[11px] text-text-secondary">
                  {job.component} · {job.command.join(' ')}
                </p>
              </li>
            ))}
          </GraphSection>
        </div>

        <DeployYamlEditor
          key={specState.desiredDigest ?? 'desired'}
          name={name}
          initialSpec={spec}
          onRevisionSaved={() => fetchGraph(true)}
        />

        <ConfigurationEditor
          configuration={configuration}
          error={configurationError}
          onSave={saveConfigurationValue}
        />
      </div>
      <ConfirmDialog
        open={confirmingApply}
        title="Apply destructive graph change?"
        message="This desired revision removes or incompatibly changes durable graph state. The local runtime will create and health-gate the replacement before activation where the plan permits, but the declared destructive effects still apply."
        confirmLabel="Apply desired revision"
        danger
        requireTypedConfirmation={name}
        onConfirm={() => void applyDesiredRevision(true)}
        onCancel={() => setConfirmingApply(false)}
      />
    </section>
  );
}

function RevisionCard({
  label,
  digest,
  source,
  manifestFormat,
  timestamp,
  tone,
}: {
  label: string;
  digest: string | null;
  source?: string | null;
  manifestFormat?: string;
  timestamp?: string;
  tone: 'success' | 'warning' | 'accent';
}) {
  const toneClass = {
    success: 'badge-success',
    warning: 'badge-warning',
    accent: 'badge-accent',
  }[tone];
  return (
    <div className="rounded-lg border border-border bg-bg/40 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
          {label} revision
        </span>
        <span className={`badge ${toneClass}`}>{sourceLabel(source)}</span>
      </div>
      <code className="mt-2 block break-all text-[11px] leading-5 text-text-secondary">
        {digest ?? 'Not activated'}
      </code>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-text-tertiary">
        {manifestFormat && <span>{manifestFormat}</span>}
        {timestamp && <span>{new Date(timestamp).toLocaleString()}</span>}
        <span>immutable</span>
      </div>
    </div>
  );
}

function GraphCount({ count, singular }: { count: number; singular: string }) {
  return (
    <span className="rounded-md border border-border bg-bg/40 px-2 py-1">
      {count} {count === 1 ? singular : `${singular}s`}
    </span>
  );
}

function renderStructuredManifest(spec: ApplicationSpec): string {
  return stringify(spec, { lineWidth: 0, sortMapEntries: true });
}

function GraphSection({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const hasChildren = Array.isArray(children) ? children.length > 0 : Boolean(children);
  return (
    <section className="overflow-hidden rounded-lg border border-border/80 bg-bg/25">
      <h3 className="border-b border-border/80 px-3 py-2 text-[10px] font-mono uppercase tracking-wider text-text-tertiary sm:px-4">
        {title}
      </h3>
      {hasChildren ? (
        <ul className="divide-y divide-border/80">{children}</ul>
      ) : (
        <p className="px-3 py-4 text-xs text-text-tertiary sm:px-4">{empty}</p>
      )}
    </section>
  );
}

function DeployYamlEditor({
  name,
  initialSpec,
  onRevisionSaved,
}: {
  name: string;
  initialSpec: ApplicationSpec;
  onRevisionSaved: () => Promise<void>;
}) {
  const titleId = useId();
  const { toast } = useToast();
  const [manifest, setManifest] = useState(() => renderStructuredManifest(initialSpec));
  const [structuredSpec, setStructuredSpec] = useState(() => structuredClone(initialSpec));
  const [editorMode, setEditorMode] = useState<'visual' | 'yaml'>('visual');
  const [draftOrigin, setDraftOrigin] = useState<'visual' | 'yaml'>('visual');
  const [preview, setPreview] = useState<ApplicationPlanResponse | null>(null);
  const [previewSource, setPreviewSource] = useState('');
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmingDestructive, setConfirmingDestructive] = useState(false);
  const [staleBase, setStaleBase] = useState<{
    baseDigest: string;
    currentDigest: string;
  } | null>(null);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  async function loadManifest() {
    const auth = getAuth();
    if (!auth) {
      setError('Authenticate again to edit deploy.yaml.');
      return;
    }

    setLoadingManifest(true);
    setError('');
    setStatus('');
    try {
      const response = await fetch(`/api/deployments/${encodeURIComponent(name)}/deploy.yaml`, {
        headers: {
          'x-deploy-username': auth.username,
          'x-deploy-token': auth.token,
        },
      });
      if (!response.ok) {
        throw new Error(await responseError(response, 'Unable to load deploy.yaml'));
      }
      setManifest(await response.text());
      setDraftOrigin('yaml');
      setEditorMode('yaml');
      setPreview(null);
      setPreviewSource('');
      setStaleBase(null);
      setStatus('Loaded the current desired revision. Edit it, then preview before saving.');
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoadingManifest(false);
    }
  }

  async function previewManifest(source: string, parentChanged = false) {
    const auth = getAuth();
    if (!auth) {
      setError('Authenticate again to preview deploy.yaml.');
      return null;
    }

    setPreviewing(true);
    setError('');
    if (!parentChanged) setStatus('');
    try {
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/application-plan`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({ manifest: source }),
        },
      );
      if (!response.ok) {
        throw new Error(await responseError(response, 'Unable to preview this revision'));
      }
      const nextPreview = (await response.json()) as ApplicationPlanResponse;
      setPreview(nextPreview);
      setPreviewSource(source);
      setStructuredSpec(structuredClone(nextPreview.normalized));
      setStatus(
        parentChanged
          ? 'The desired revision changed elsewhere. The plan was refreshed against the latest parent; review it before saving again.'
          : 'Preview is current. Saving will record a desired revision only; it will not apply or deploy it.',
      );
      return nextPreview;
    } catch (previewError) {
      setPreview(null);
      setPreviewSource('');
      setError((previewError as Error).message);
      return null;
    } finally {
      setPreviewing(false);
    }
  }

  async function saveDesiredRevision(confirmDestructive: boolean) {
    if (!manifest || !preview || previewSource !== manifest) {
      setError('Preview the current editor contents before saving.');
      return;
    }

    const auth = getAuth();
    if (!auth) {
      setError('Authenticate again to save deploy.yaml.');
      return;
    }

    setConfirmingDestructive(false);
    setSaving(true);
    setError('');
    setStatus('');
    try {
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/application-spec`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({
            manifest,
            expectedParentDigest: preview.parentDigest,
            confirmDestructive,
          }),
        },
      );
      const body = (await response.json()) as ApiErrorBody & {
        desiredDigest?: string;
        manifest?: string;
        applied?: boolean;
      };
      if (!response.ok) {
        if (response.status === 409 && Object.hasOwn(body, 'expectedParentDigest')) {
          const previousBase = preview.parentDigest;
          setPreview(null);
          setPreviewSource('');
          await onRevisionSaved();
          if (typeof body.expectedParentDigest === 'string') {
            setStaleBase({
              baseDigest: previousBase,
              currentDigest: body.expectedParentDigest,
            });
            setStatus(
              'The desired revision changed elsewhere. Choose Rebase, Replace, or Cancel; no graph change was saved.',
            );
            return;
          }
          return;
        }
        throw new Error(body.error || 'Unable to save this desired revision');
      }

      if (body.manifest) setManifest(body.manifest);
      setPreview(null);
      setPreviewSource('');
      setStaleBase(null);
      setStatus('Desired revision saved. It has not been applied or deployed.');
      toast(`application-spec-${name}`, {
        type: 'success',
        title: 'Desired revision saved',
        description: 'The revision is durable, but it has not been applied or deployed.',
      });
      await onRevisionSaved();
    } catch (saveError) {
      setError((saveError as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const previewIsCurrent = Boolean(preview && previewSource === manifest);
  const saveDisabled = saving || previewing || !previewIsCurrent || Boolean(preview?.plan.blocked);
  const structuredAvailable = draftOrigin === 'visual' || previewIsCurrent;

  function updateStructuredSpec(next: ApplicationSpec) {
    const source = renderStructuredManifest(next);
    setStructuredSpec(next);
    setManifest(source);
    setDraftOrigin('visual');
    setPreview(null);
    setPreviewSource('');
    setStaleBase(null);
    setError('');
    setStatus('Draft changed. Preview it to see the exact graph, data, and runtime plan.');
  }

  async function rebaseStaleRevision() {
    if (!staleBase || !manifest) return;
    const auth = getAuth();
    if (!auth) return;
    setPreviewing(true);
    setError('');
    try {
      const response = await fetch(
        `/api/deployments/${encodeURIComponent(name)}/application-rebase`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-deploy-username': auth.username,
            'x-deploy-token': auth.token,
          },
          body: JSON.stringify({ manifest, baseDigest: staleBase.baseDigest }),
        },
      );
      const body = (await response.json()) as {
        error?: string;
        ready?: boolean;
        conflicts?: string[];
        manifest?: string;
      };
      if (!response.ok) throw new Error(body.error || 'Unable to rebase this revision');
      if (!body.ready || !body.manifest) {
        throw new Error(
          `Rebase has overlapping edits at ${(body.conflicts ?? []).join(', ') || 'unknown fields'}. Replace or cancel instead.`,
        );
      }
      setManifest(body.manifest);
      setStaleBase(null);
      await previewManifest(body.manifest, true);
    } catch (rebaseError) {
      setError((rebaseError as Error).message);
    } finally {
      setPreviewing(false);
    }
  }

  async function replaceStaleRevision() {
    if (!manifest) return;
    setStaleBase(null);
    await previewManifest(manifest, true);
    setStatus('Replacement preview is current. Review its full impact before saving explicitly.');
  }

  return (
    <section
      id="application-graph-editor"
      className="scroll-mt-24 overflow-hidden rounded-lg border border-border/80 bg-bg/25"
      aria-labelledby={titleId}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-3 py-3 sm:px-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3
              id={titleId}
              className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary"
            >
              Application graph editor
            </h3>
            <span className="badge badge-warning">Desired state only</span>
          </div>
          <p className="mt-1 max-w-2xl text-[11px] text-text-secondary">
            Use the structured editor for common graph changes or switch to YAML for the complete
            contract. Both produce the same manifest and exact semantic preview.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm text-xs"
          onClick={() => void loadManifest()}
          disabled={loadingManifest || saving}
        >
          {loadingManifest ? 'Loading…' : 'Reload current deploy.yaml'}
        </button>
      </header>

      <div className="space-y-4 p-3 sm:p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 pb-3">
          <div
            className="inline-flex rounded-md border border-border bg-bg p-1"
            role="tablist"
            aria-label="Graph editor mode"
          >
            <button
              type="button"
              role="tab"
              aria-selected={editorMode === 'visual'}
              className={`rounded px-3 py-1.5 text-xs ${editorMode === 'visual' ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text'}`}
              onClick={() => setEditorMode('visual')}
              disabled={!structuredAvailable}
              title={
                structuredAvailable
                  ? undefined
                  : 'Preview the YAML draft before returning to the structured editor.'
              }
            >
              Structured editor
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={editorMode === 'yaml'}
              className={`rounded px-3 py-1.5 text-xs ${editorMode === 'yaml' ? 'bg-accent/15 text-accent' : 'text-text-secondary hover:text-text'}`}
              onClick={() => setEditorMode('yaml')}
            >
              Advanced YAML
            </button>
          </div>
          <span className="text-[10px] text-text-tertiary">
            Secret values are never written into either editor.
          </span>
        </div>

        {editorMode === 'visual' ? (
          <div role="tabpanel" aria-label="Structured graph editor">
            <StructuredGraphEditor
              value={structuredSpec}
              disabled={saving || previewing}
              onChange={updateStructuredSpec}
            />
          </div>
        ) : (
          <div role="tabpanel" aria-label="Advanced YAML editor">
            <label htmlFor={`${titleId}-manifest`} className="sr-only">
              deploy.yaml contents
            </label>
            <textarea
              id={`${titleId}-manifest`}
              className="input min-h-80 resize-y whitespace-pre font-mono text-xs leading-5 sm:min-h-96"
              value={manifest}
              onChange={(event) => {
                setManifest(event.target.value);
                setDraftOrigin('yaml');
                setError('');
                setStatus('');
                if (previewSource !== event.target.value) setPreview(null);
              }}
              disabled={saving}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
            />
            {draftOrigin === 'yaml' && !previewIsCurrent && (
              <p className="mt-2 text-[11px] text-text-tertiary">
                Preview this YAML draft to validate it and make it available in the structured
                editor.
              </p>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3">
          <p className="text-[11px] text-text-tertiary">
            A preview is required after every edit and is bound to the latest desired digest.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn btn-sm text-xs"
              onClick={() => void previewManifest(manifest)}
              disabled={previewing || saving || !manifest.trim()}
            >
              {previewing ? 'Previewing…' : 'Preview changes'}
            </button>
            <button
              type="button"
              className="btn btn-primary btn-sm text-xs"
              onClick={() => {
                if (preview?.plan.destructive) setConfirmingDestructive(true);
                else void saveDesiredRevision(false);
              }}
              disabled={saveDisabled}
            >
              {saving ? 'Saving…' : 'Save desired revision'}
            </button>
          </div>
        </div>

        <div aria-live="polite">
          {error && (
            <p role="alert" className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </p>
          )}
          {!error && status && (
            <p className="rounded-md bg-accent/10 px-3 py-2 text-xs text-text-secondary">
              {status}
            </p>
          )}
        </div>

        {staleBase && (
          <div className="rounded-lg border border-warning/40 bg-warning/8 p-3">
            <p className="text-xs font-medium text-warning">Repository ancestry changed</p>
            <p className="mt-1 text-[11px] text-text-secondary">
              Your edit is based on {shortDigest(staleBase.baseDigest)}, while the desired graph is
              now {shortDigest(staleBase.currentDigest)}. No change has been saved.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                className="btn btn-primary btn-sm text-xs"
                onClick={() => void rebaseStaleRevision()}
                disabled={previewing}
              >
                Rebase
              </button>
              <button
                type="button"
                className="btn btn-sm text-xs"
                onClick={() => void replaceStaleRevision()}
                disabled={previewing}
              >
                Replace
              </button>
              <button
                type="button"
                className="btn btn-sm text-xs"
                onClick={() => void loadManifest()}
                disabled={previewing}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {preview && previewIsCurrent && <ApplicationPlanPreview preview={preview} />}
      </div>

      <ConfirmDialog
        open={confirmingDestructive}
        title="Save destructive desired revision?"
        message="This preview removes or incompatibly changes durable graph state. Confirm saving the desired revision only after reviewing every action. Saving still does not apply or deploy it."
        confirmLabel="Save desired revision"
        danger
        requireTypedConfirmation={name}
        onConfirm={() => void saveDesiredRevision(true)}
        onCancel={() => setConfirmingDestructive(false)}
      />
    </section>
  );
}

function ApplicationPlanPreview({ preview }: { preview: ApplicationPlanResponse }) {
  const { plan } = preview;
  return (
    <section
      className="overflow-hidden rounded-lg border border-border/80"
      aria-label="Change plan"
    >
      <header className="border-b border-border/80 bg-bg/40 px-3 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-semibold text-text">Change plan</h4>
          <PlanFlag active={plan.blocked} label="Blocked" tone="danger" />
          <PlanFlag active={plan.destructive} label="Destructive" tone="danger" />
          <PlanFlag active={plan.restartRequired} label="Restart" tone="warning" />
          <PlanFlag active={plan.requiresApproval} label="Approval" tone="warning" />
          {!plan.blocked &&
            !plan.destructive &&
            !plan.restartRequired &&
            !plan.requiresApproval && <span className="badge badge-success">Safe revision</span>}
        </div>
        <div className="mt-2 grid gap-1 font-mono text-[10px] text-text-tertiary sm:grid-cols-2">
          <span className="break-all">parent {preview.parentDigest}</span>
          <span className="break-all">candidate {preview.candidateDigest}</span>
        </div>
        <dl className="mt-3 grid gap-2 text-[10px] sm:grid-cols-5">
          <PlanImpact
            label="Capacity"
            value={`${plan.impacts.capacity.currentInstances} → ${plan.impacts.capacity.desiredInstances} · peak ${plan.impacts.capacity.peakInstances}`}
          />
          <PlanImpact label="Downtime" value={plan.impacts.downtime.expectation} />
          <PlanImpact label="Backup" value={plan.impacts.backup.disposition} />
          <PlanImpact label="Data" value={plan.impacts.data.effect} />
          <PlanImpact label="Suitcase" value={plan.impacts.suitcase.disposition} />
        </dl>
        {plan.blocked && (
          <p className="mt-2 text-[11px] text-danger">
            This plan cannot be saved until every blocked change is resolved.
          </p>
        )}
      </header>
      <ul className="divide-y divide-border/80">
        {plan.actions.map((action, index) => (
          <ApplicationPlanAction
            key={`${action.address}-${action.classification}-${index}`}
            action={action}
          />
        ))}
      </ul>
    </section>
  );
}

function PlanImpact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/70 bg-bg px-2 py-2">
      <dt className="font-mono uppercase tracking-wider text-text-tertiary">{label}</dt>
      <dd className="mt-1 text-text-secondary">{value.replaceAll('-', ' ')}</dd>
    </div>
  );
}

function ApplicationPlanAction({ action }: { action: ApplicationChangeAction }) {
  return (
    <li className="px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="badge bg-bg-active text-text-secondary ring-1 ring-border">
          {action.classification}
        </span>
        <span className="badge bg-bg-active text-text-tertiary ring-1 ring-border">
          {action.effect}
        </span>
        {action.blocked && <span className="badge badge-danger">blocked</span>}
        {action.destructive && <span className="badge badge-danger">destructive</span>}
        {action.restartRequired && <span className="badge badge-warning">restart</span>}
        {action.requiresApproval && <span className="badge badge-warning">approval</span>}
      </div>
      <p className="mt-2 text-xs text-text-secondary">{action.reason}</p>
      <code className="mt-1 block break-all text-[10px] text-text-tertiary">
        {action.changedAddresses.length > 0 ? action.changedAddresses.join(', ') : action.address}
      </code>
    </li>
  );
}

function PlanFlag({
  active,
  label,
  tone,
}: {
  active: boolean;
  label: string;
  tone: 'warning' | 'danger';
}) {
  const activeClass = tone === 'danger' ? 'badge-danger' : 'badge-warning';
  return (
    <span className={`badge ${active ? activeClass : 'bg-bg-active text-text-tertiary'}`}>
      {label}: {active ? 'yes' : 'no'}
    </span>
  );
}

function ConfigurationEditor({
  configuration,
  error,
  onSave,
}: {
  configuration: ConfigurationResponse | null;
  error: string;
  onSave: (key: string, value: ConfigurationValue) => Promise<void>;
}) {
  if (!configuration) {
    return (
      <section className="rounded-lg border border-warning/30 bg-warning/8 p-3 sm:p-4">
        <p className="text-xs font-medium text-warning">Configuration readiness unavailable</p>
        <p className="mt-1 text-[11px] text-text-secondary">{error}</p>
      </section>
    );
  }

  const declarations = sortedEntries(configuration.declarations);
  return (
    <section className="overflow-hidden rounded-lg border border-border/80 bg-bg/25">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border/80 px-3 py-3 sm:px-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
              Configuration readiness
            </h3>
            <span
              className={`badge ${configuration.ready ? 'badge-success' : 'badge-warning'}`}
              role="status"
            >
              {configuration.ready ? 'Ready' : `${configuration.missing.length} missing`}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-text-secondary">
            Values resolve on {configuration.siteId}; secret contents are never returned here.
          </p>
        </div>
        <code
          className="max-w-full break-all text-[10px] text-text-tertiary"
          title="Configuration digest"
        >
          {configuration.configurationDigest}
        </code>
      </header>
      {declarations.length === 0 ? (
        <p className="px-3 py-4 text-xs text-text-tertiary sm:px-4">
          This graph has no administrator-supplied configuration.
        </p>
      ) : (
        <ul className="grid grid-cols-1 divide-y divide-border/80 sm:grid-cols-2 sm:divide-y-0">
          {declarations.map(([key, declaration]) => (
            <li
              key={key}
              className="border-border/80 px-3 py-3 sm:border-b sm:odd:border-r sm:px-4"
            >
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs font-semibold text-text">{key}</code>
                <span className="badge bg-bg-active text-text-secondary ring-1 ring-border">
                  {declaration.type}
                </span>
                <span className="text-[10px] text-text-tertiary">{declaration.scope}</span>
                <span
                  className={`ml-auto text-[10px] font-medium ${
                    declaration.configured ? 'text-success' : 'text-warning'
                  }`}
                >
                  {declaration.configured ? 'Configured' : 'Missing'}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-text-secondary">
                {declaration.description ??
                  (declaration.required ? 'Required before start.' : 'Optional configuration.')}
              </p>
              {declaration.configured && declaration.revision > 0 && (
                <p className="mt-1 text-[10px] text-text-tertiary">
                  Stored revision {declaration.revision}
                  {declaration.updatedAt
                    ? ` · updated ${new Date(declaration.updatedAt).toLocaleString()}`
                    : ''}
                </p>
              )}
              <ConfigurationValueForm name={key} declaration={declaration} onSave={onSave} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ConfigurationValueForm({
  name,
  declaration,
  onSave,
}: {
  name: string;
  declaration: ConfigurationDeclarationView;
  onSave: (key: string, value: ConfigurationValue) => Promise<void>;
}) {
  const inputId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const rawValue = new FormData(form).get('value');
    try {
      const value = parseConfigurationInput(declaration, rawValue);
      if (declaration.type === 'secret') form.reset();
      setSaving(true);
      setError('');
      await onSave(name, value);
      formRef.current?.reset();
    } catch (saveError) {
      setError((saveError as Error).message);
      if (declaration.type === 'secret') formRef.current?.reset();
    } finally {
      setSaving(false);
    }
  }

  return (
    <form ref={formRef} className="mt-3" onSubmit={(event) => void submit(event)}>
      <label htmlFor={inputId} className="mb-1.5 block text-[10px] font-medium text-text-tertiary">
        <span className="sr-only">{name}: </span>
        {declaration.configured ? 'Replace stored value' : 'Set value'}
        {declaration.default !== undefined && declaration.revision === 0
          ? ` · default ${formatConfigurationValue(declaration.default)}`
          : ''}
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <ConfigurationInput id={inputId} declaration={declaration} disabled={saving} />
        <button type="submit" className="btn btn-sm shrink-0 text-xs" disabled={saving}>
          {saving
            ? 'Saving…'
            : declaration.type === 'secret' && declaration.configured
              ? 'Replace secret'
              : 'Save value'}
        </button>
      </div>
      {declaration.type === 'secret' && (
        <p className="mt-1.5 text-[10px] text-text-tertiary">
          Secret plaintext is never returned and is cleared from this form immediately on submit.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-1.5 text-[10px] text-danger">
          {error}
        </p>
      )}
    </form>
  );
}

function ConfigurationInput({
  id,
  declaration,
  disabled,
}: {
  id: string;
  declaration: ConfigurationDeclarationView;
  disabled: boolean;
}) {
  if (declaration.allowedValues && declaration.allowedValues.length > 0) {
    return (
      <select id={id} name="value" className="input input-sm" defaultValue="" disabled={disabled}>
        <option value="">Choose an allowed value…</option>
        {declaration.allowedValues.map((value, index) => (
          <option key={`${typeof value}-${String(value)}-${index}`} value={String(index)}>
            {formatConfigurationValue(value)}
          </option>
        ))}
      </select>
    );
  }

  if (declaration.type === 'boolean') {
    return (
      <select id={id} name="value" className="input input-sm" defaultValue="" disabled={disabled}>
        <option value="">Choose true or false…</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  }

  if (declaration.type === 'file') {
    return (
      <textarea
        id={id}
        name="value"
        className="input input-sm min-h-24 min-w-0 resize-y font-mono"
        placeholder={
          declaration.configured ? 'Enter replacement file contents…' : 'Enter file contents…'
        }
        disabled={disabled}
        autoComplete="off"
      />
    );
  }

  return (
    <input
      id={id}
      name="value"
      type={
        declaration.type === 'secret'
          ? 'password'
          : declaration.type === 'number' || declaration.type === 'integer'
            ? 'number'
            : declaration.type === 'url'
              ? 'url'
              : 'text'
      }
      className="input input-sm min-w-0"
      placeholder={declaration.configured ? 'Enter a replacement…' : 'Enter a value…'}
      disabled={disabled}
      autoComplete={declaration.type === 'secret' ? 'new-password' : 'off'}
      step={
        declaration.type === 'number' ? 'any' : declaration.type === 'integer' ? '1' : undefined
      }
    />
  );
}

function parseConfigurationInput(
  declaration: ConfigurationDeclarationView,
  rawValue: FormDataEntryValue | null,
): ConfigurationValue {
  if (typeof rawValue !== 'string') throw new Error('Enter a value before saving.');

  if (declaration.allowedValues && declaration.allowedValues.length > 0) {
    if (!rawValue) throw new Error('Choose an allowed value before saving.');
    const value = declaration.allowedValues[Number(rawValue)];
    if (value === undefined || value === null) throw new Error('Choose a valid allowed value.');
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new Error('This allowed value type is not supported by the editor.');
    }
    return value;
  }

  if (declaration.type === 'boolean') {
    if (rawValue === 'true') return true;
    if (rawValue === 'false') return false;
    throw new Error('Choose true or false before saving.');
  }
  if (declaration.type === 'number' || declaration.type === 'integer') {
    if (!rawValue.trim()) throw new Error('Enter a number before saving.');
    const value = Number(rawValue);
    if (!Number.isFinite(value)) throw new Error('Enter a finite number.');
    if (declaration.type === 'integer' && !Number.isSafeInteger(value)) {
      throw new Error('Enter a safe integer.');
    }
    return value;
  }
  if (declaration.type === 'url') {
    try {
      const parsed = new URL(rawValue);
      if (!parsed.protocol || !parsed.hostname) throw new Error();
    } catch {
      throw new Error('Enter an absolute URL.');
    }
  }
  return rawValue;
}

function formatConfigurationValue(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function GraphLoading() {
  return (
    <section className="card p-4 sm:p-5" aria-label="Loading application graph">
      <div className="h-3 w-32 animate-pulse rounded bg-bg-active motion-reduce:animate-none" />
      <div className="mt-3 h-5 w-56 animate-pulse rounded bg-bg-active motion-reduce:animate-none" />
      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <div className="h-24 animate-pulse rounded-lg bg-bg-active motion-reduce:animate-none" />
        <div className="h-24 animate-pulse rounded-lg bg-bg-active motion-reduce:animate-none" />
      </div>
    </section>
  );
}

function sourceLabel(source?: string | null): string {
  if (!source) return 'unknown source';
  return source
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function shortDigest(value: string): string {
  return value.length > 24 ? `${value.slice(0, 21)}…` : value;
}

function formatBytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function buildLabel(build: ApplicationSpec['components'][string]['build']): string {
  if (!build) return 'No image or build source';
  return `Build ${build.context}${build.target ? ` · target ${build.target}` : ''}`;
}

function sortedEntries<T>(value: Record<string, T>): Array<[string, T]> {
  return Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
}

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || fallback;
  } catch {
    return fallback;
  }
}
