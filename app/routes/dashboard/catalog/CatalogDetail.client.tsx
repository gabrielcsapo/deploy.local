'use client';

import { Link, useParams } from 'react-flight-router/client';
import type { ApplicationSpec } from '../../../../server/application-spec.ts';
import CatalogInstallPanel from './CatalogInstallPanel.client.tsx';
import type { CatalogUiRelease } from './ui-types.ts';

export default function CatalogDetailClient({ releases }: { releases: CatalogUiRelease[] }) {
  const { blueprintId, release: releaseVersion } = useParams();
  const release = releases.find(
    (candidate) => candidate.id === blueprintId && candidate.release === releaseVersion,
  );

  if (!release) {
    return (
      <div className="card p-6">
        <p className="eyebrow">Catalog release</p>
        <h1 className="mt-2 text-lg font-semibold text-text">Release not found</h1>
        <p className="mt-2 text-sm text-text-secondary">
          This signed blueprint release is not present in the local catalog snapshot.
        </p>
        <Link to="/dashboard/catalog" className="btn btn-sm mt-4">
          Return to Catalog
        </Link>
      </div>
    );
  }

  const blockers = release.preflight.findings.filter((finding) => finding.severity === 'blocking');
  const passedEvidence = release.evidence.filter((item) => item.result === 'passed').length;
  return (
    <div className="space-y-5">
      <header className="card overflow-hidden">
        <div className="border-b border-border px-5 py-5 sm:px-6 sm:py-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0 max-w-3xl">
              <div className="flex flex-wrap items-center gap-2">
                <span className="badge badge-success">Release contract verified</span>
                <span className="badge badge-success">Signature verified</span>
                <span className="font-mono text-[10px] text-text-tertiary">
                  {release.id}@{release.release}
                </span>
              </div>
              <h1 className="mt-3 text-2xl font-semibold tracking-tight text-text">
                {release.name}
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-text-secondary">
                {release.description}
              </p>
            </div>
            <span className="badge badge-accent">Administrator install workflow below</span>
          </div>
        </div>
        <div className="grid gap-px bg-border sm:grid-cols-3">
          <LedgerCell label="Publisher" value={`${release.publisher} · ${release.trustTier}`} />
          <LedgerCell label="License" value={release.license} />
          <LedgerCell label="Release scope" value={release.supportScope} />
        </div>
        <div className="border-t border-border bg-bg/30 px-5 py-3 font-mono text-[10px] text-text-tertiary sm:px-6">
          <p className="break-all">content {release.contentDigest}</p>
          <p className="mt-1 break-all">signing key {release.signatureKeyId}</p>
        </div>
      </header>

      <CatalogInstallPanel release={release} />

      <section className="card overflow-hidden" aria-labelledby="compatibility-title">
        <SectionHeader
          id="compatibility-title"
          eyebrow="Compatibility ledger"
          title="Explicit compatibility claims"
          description="The release contract keeps operational support separate from target, offline, suitcase, and reconciliation behavior."
        />
        <dl className="grid grid-cols-1 gap-px bg-border sm:grid-cols-2 lg:grid-cols-5">
          {Object.entries(release.promises).map(([name, value]) => (
            <div key={name} className="bg-bg-surface px-4 py-4">
              <dt className="text-[10px] font-mono uppercase tracking-wider text-text-tertiary">
                {promiseLabel(name)}
              </dt>
              <dd className="mt-2">
                <PromiseBadge value={value} />
              </dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="card overflow-hidden" aria-labelledby="graph-title">
        <SectionHeader
          id="graph-title"
          eyebrow="Normalized application graph"
          title={`${Object.keys(release.graph.components).length} components · ${Object.keys(release.graph.resources).length} resources · ${Object.keys(release.graph.jobs).length} jobs`}
          description="Every catalog source compiles into the same immutable ApplicationSpec used by deploy.yaml."
        />
        <GraphPreview graph={release.graph} />
        <GraphTable graph={release.graph} />
      </section>

      <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
        <section className="card overflow-hidden" aria-labelledby="security-title">
          <SectionHeader
            id="security-title"
            eyebrow="Host access review"
            title={`${release.security.length} declared security grants`}
            description="Required and optional grants are visible before any runtime transaction."
          />
          {release.security.length === 0 ? (
            <p className="px-4 py-5 text-sm text-text-secondary sm:px-5">
              No host, device, privileged, or LAN grants are declared by this fixture.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {release.security.map((grant) => (
                <li key={grant.id} className="px-4 py-4 sm:px-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-xs font-semibold text-text">{grant.kind}</code>
                    <span className={`badge ${grant.required ? 'badge-danger' : 'badge-warning'}`}>
                      {grant.required ? 'required' : 'optional'}
                    </span>
                    <span className="font-mono text-[10px] text-text-tertiary">
                      {grant.component}
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-text-secondary">{grant.reason}</p>
                  {grant.value && (
                    <code className="mt-2 block break-all rounded bg-bg/60 px-2 py-1 text-[10px] text-text-tertiary">
                      {grant.value}
                    </code>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="card overflow-hidden" aria-labelledby="target-title">
          <SectionHeader
            id="target-title"
            eyebrow="Target contract"
            title="Declared minimum envelope"
            description="A real preflight compares this matrix to the administrator-selected site."
          />
          <dl className="grid grid-cols-2 gap-px bg-border">
            <LedgerCell label="deploy.local" value={release.deployLocalVersionRange} />
            <LedgerCell
              label="Operating systems"
              value={release.target.operatingSystems.join(', ')}
            />
            <LedgerCell label="Architectures" value={release.target.architectures.join(', ')} />
            <LedgerCell label="Container engines" value={release.target.engines.join(', ')} />
            <LedgerCell
              label="Minimum engine"
              value={release.target.minimumEngineVersion || 'not declared'}
            />
            <LedgerCell label="Memory" value={`${release.target.minimumMemoryMiB} MiB`} />
            <LedgerCell label="Storage" value={`${release.target.minimumStorageMiB} MiB`} />
            <LedgerCell label="CPU" value={`${release.target.minimumCpuCores} cores`} />
            <LedgerCell label="Preflight target" value="reference-home" />
          </dl>
        </section>
      </div>

      <section className="card overflow-hidden" aria-labelledby="preflight-title">
        <SectionHeader
          id="preflight-title"
          eyebrow="Read-only preflight"
          title={`${blockers.length} blocking findings on the reference Home target`}
          description="This preview is non-mutating. It uses an 8 GiB Linux/amd64 Docker Engine target and does not invent devices or completed evidence."
        />
        <div className="grid gap-px bg-border lg:grid-cols-[minmax(0,1.2fr)_minmax(18rem,0.8fr)]">
          <ul className="divide-y divide-border bg-bg-surface">
            {release.preflight.findings.map((finding) => (
              <li key={finding.id} className="px-4 py-3 sm:px-5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`badge ${
                      finding.severity === 'blocking'
                        ? 'badge-danger'
                        : finding.severity === 'warning'
                          ? 'badge-warning'
                          : 'badge-accent'
                    }`}
                  >
                    {finding.severity}
                  </span>
                  <code className="text-[10px] text-text-tertiary">{finding.dimension}</code>
                </div>
                <p className="mt-2 text-xs text-text-secondary">{finding.summary}</p>
                {finding.remediation && (
                  <p className="mt-1 text-[11px] text-text-tertiary">{finding.remediation}</p>
                )}
              </li>
            ))}
          </ul>
          <div className="bg-bg-surface p-4 sm:p-5">
            <h3 className="text-xs font-semibold text-text">Install transaction preview</h3>
            <p className="mt-1 text-[11px] text-text-tertiary">
              Steps are ordered because health admission and commit are real gates.
            </p>
            <ol className="mt-4 space-y-3">
              {release.installPlan.steps.map((step, index) => (
                <li key={step.id} className="grid grid-cols-[1.5rem_minmax(0,1fr)] gap-2">
                  <span className="flex size-6 items-center justify-center rounded-full border border-border bg-bg font-mono text-[10px] text-text-tertiary">
                    {index + 1}
                  </span>
                  <div>
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-xs font-medium text-text">{step.summary}</p>
                      {step.destructive && <span className="badge badge-danger">destructive</span>}
                    </div>
                    <p className="mt-1 text-[10px] text-text-tertiary">{step.rollback}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      </section>

      <section className="card overflow-hidden" aria-labelledby="evidence-title">
        <SectionHeader
          id="evidence-title"
          eyebrow="Support evidence"
          title={`${passedEvidence} of ${release.evidence.length} lifecycle checks passed`}
          description="Each check has an explicit result. Checks that have not run are shown as not run and are never treated as successful."
        />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-left text-xs">
            <thead className="bg-bg/50 font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
              <tr>
                <th className="px-4 py-2 font-medium sm:px-5">Evidence</th>
                <th className="px-4 py-2 font-medium">Target</th>
                <th className="px-4 py-2 font-medium">Result</th>
                <th className="px-4 py-2 font-medium">Summary</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {release.evidence.map((evidence) => (
                <tr key={evidence.id}>
                  <td className="px-4 py-3 font-mono text-text sm:px-5">{evidence.kind}</td>
                  <td className="px-4 py-3 text-text-secondary">{evidence.target}</td>
                  <td className="px-4 py-3">
                    <span
                      className={`badge ${
                        evidence.result === 'passed'
                          ? 'badge-success'
                          : evidence.result === 'failed'
                            ? 'badge-danger'
                            : 'badge-warning'
                      }`}
                    >
                      {evidence.result === 'not-run' ? 'Not run' : evidence.result}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-text-secondary">{evidence.summary}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to="/dashboard/catalog" className="btn btn-sm">
          Back to Catalog
        </Link>
        <p className="text-[11px] text-text-tertiary">
          Reviewing or planning never mutates runtime or catalog state.
        </p>
      </div>
    </div>
  );
}

function GraphPreview({ graph }: { graph: ApplicationSpec }) {
  return (
    <div
      className="border-b border-border bg-bg/20 p-4 sm:p-5"
      aria-label="Application graph visual"
    >
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {Object.entries(graph.components).map(([name, component]) => (
          <article key={name} className="rounded-lg border border-border bg-bg-surface p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <code className="text-xs font-semibold text-text">{name}</code>
              <span className="badge badge-accent">
                {component.instances === 1
                  ? component.role
                  : `${component.role} ×${component.instances}`}
              </span>
            </div>
            <p
              className="mt-2 truncate font-mono text-[10px] text-text-tertiary"
              title={component.image}
            >
              {component.image}
            </p>
            <p className="mt-3 text-[10px] text-text-secondary">
              {component.dependsOn.length > 0
                ? `depends on → ${component.dependsOn.join(', ')}`
                : 'root component'}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {Object.entries(component.interfaces).map(([interfaceName, item]) => (
                <span
                  key={interfaceName}
                  className="rounded border border-border bg-bg/50 px-1.5 py-0.5 font-mono text-[9px] text-text-tertiary"
                >
                  {interfaceName} {item.protocol}:{item.port}
                </span>
              ))}
              {component.profile && (
                <span className="badge badge-success">{component.profile}</span>
              )}
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}

function GraphTable({ graph }: { graph: ApplicationSpec }) {
  return (
    <details className="group">
      <summary className="cursor-pointer px-4 py-3 text-xs font-medium text-text-secondary hover:text-text sm:px-5">
        Application graph table · accessible alternate view
      </summary>
      <div className="overflow-x-auto border-t border-border">
        <table className="w-full min-w-[38rem] text-left text-xs">
          <thead className="bg-bg/50 font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
            <tr>
              <th className="px-4 py-2 font-medium sm:px-5">Component</th>
              <th className="px-4 py-2 font-medium">Role / instances</th>
              <th className="px-4 py-2 font-medium">Depends on</th>
              <th className="px-4 py-2 font-medium">Interfaces</th>
              <th className="px-4 py-2 font-medium">Persistent mounts</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {Object.entries(graph.components).map(([name, component]) => (
              <tr key={name}>
                <td className="px-4 py-3 font-mono text-text sm:px-5">{name}</td>
                <td className="px-4 py-3 text-text-secondary">
                  {component.role} ×{component.instances}
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  {component.dependsOn.join(', ') || 'none'}
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  {Object.entries(component.interfaces)
                    .map(([key, value]) => `${key} ${value.protocol}:${value.port}`)
                    .join(', ') || 'none'}
                </td>
                <td className="px-4 py-3 text-text-secondary">
                  {Object.entries(component.mounts)
                    .map(([path, mount]) => `${path} ← ${mount.resource}`)
                    .join(', ') || 'none'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function PromiseBadge({ value }: { value: string }) {
  const tone =
    value === 'verified'
      ? 'badge-success'
      : value === 'declared'
        ? 'badge-accent'
        : value === 'not-supported'
          ? 'badge-danger'
          : 'bg-bg-active text-text-tertiary ring-1 ring-border';
  return <span className={`badge ${tone}`}>{value === 'unknown' ? 'not declared' : value}</span>;
}

function promiseLabel(name: string): string {
  return name === 'install'
    ? 'Install'
    : name === 'lifecycle'
      ? 'Lifecycle'
      : name === 'offline'
        ? 'Works offline'
        : name === 'suitcase'
          ? 'Suitcase'
          : 'Data reconciliation';
}

function SectionHeader({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <header className="border-b border-border px-4 py-4 sm:px-5">
      <p className="eyebrow">{eyebrow}</p>
      <h2 id={id} className="mt-1.5 text-base font-semibold tracking-tight text-text">
        {title}
      </h2>
      <p className="mt-1 max-w-3xl text-xs leading-relaxed text-text-secondary">{description}</p>
    </header>
  );
}

function LedgerCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-bg-surface px-4 py-3 sm:px-5">
      <p className="text-[9px] font-mono uppercase tracking-wider text-text-tertiary">{label}</p>
      <p className="mt-1 text-xs leading-relaxed text-text-secondary">{value}</p>
    </div>
  );
}
