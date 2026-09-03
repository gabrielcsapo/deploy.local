import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <div className="not-prose mb-8 rounded-xl border border-success/30 bg-success/8 p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="badge badge-success">v1 implemented · evidence scoped</span>
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-tertiary">
            capability and support status
          </span>
        </div>
        <p className="mt-3 max-w-[70ch] text-sm leading-relaxed text-text-secondary">
          Application graphs, the Catalog, Docker-backed Suitcases, authenticated fleet sync, and
          supported data reconciliation are implemented in v1. Readiness remains specific to an
          exact application release, target, data shape, and evidence set; implementation alone is
          not a claim that every device or upstream configuration has been physically tested.
        </p>
      </div>

      <h1>Application cloud capability map</h1>
      <p>
        deploy.local&apos;s durable object is an application graph. Source projects, UI-authored
        revisions, signed Catalog blueprints, and the reviewed Compose subset normalize into the
        same versioned specification. That graph is materialized at Home or on selected Suitcase
        sites and remains inspectable as revisions, runtime state, releases, and data lineage.
      </p>

      <h2>Capability status</h2>
      <table>
        <thead>
          <tr>
            <th>Capability</th>
            <th>Status</th>
            <th>v1 promise and boundary</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Versioned application graph</td>
            <td>
              <strong>Available</strong>
            </td>
            <td>
              Parse, validate, normalize, digest, plan, inspect, and export{' '}
              <code>apiVersion: deploy.local/v1</code> manifests with immutable revision ancestry.
            </td>
          </tr>
          <tr>
            <td>Typed configuration and secrets</td>
            <td>
              <strong>Available</strong>
            </td>
            <td>
              Declare required values in YAML, resolve encrypted values server-side, gate affected
              components, and keep secret contents out of manifests and support exports.
            </td>
          </tr>
          <tr>
            <td>Multi-component graph executor</td>
            <td>
              <strong>Available</strong>
            </td>
            <td>
              Run build- or image-backed components, fixed instance groups, stable private services,
              scoped jobs, volumes, and health-gated routes at Home, on selected Suitcases, or on
              one connected execution agent. Cross-node component distribution and multiple
              independent remote route relays remain outside v1.
            </td>
          </tr>
          <tr>
            <td>Supported application Catalog</td>
            <td>
              <strong>Available</strong>
            </td>
            <td>
              Verify and install signed immutable blueprint releases pinned to exact OCI artifacts;
              lifecycle, target, offline, and data support remain separate evidence-backed results.
            </td>
          </tr>
          <tr>
            <td>Sites and Suitcases</td>
            <td>
              <strong>Available</strong>
            </td>
            <td>
              Pair a portable Docker-backed site, retain selected replicas, build and administer
              locally while away, and exchange authenticated events and artifacts when docked.
              Native Wi-Fi/AP control remains host- and hardware-specific.
            </td>
          </tr>
          <tr>
            <td>Disconnected data reconciliation</td>
            <td>
              <strong>Available when admitted</strong>
            </td>
            <td>
              Reconcile compatible SQLite rows and uploaded files from Home and multiple Suitcases,
              preserving ambiguous conflicts for an administrator. Opaque or unsafe state follows
              one writer site or stays explicitly site-local.
            </td>
          </tr>
          <tr>
            <td>PostgreSQL lifecycle profile</td>
            <td>
              <strong>Available</strong>
            </td>
            <td>
              Run PostgreSQL as an ordinary component with private bindings, migration, logical
              backup/restore, and version-aware lifecycle contracts. This does not claim
              disconnected PostgreSQL multi-writer merge.
            </td>
          </tr>
          <tr>
            <td>Home recovery</td>
            <td>
              <strong>Available</strong>
            </td>
            <td>
              Create, verify, rehearse, and restore encrypted recovery bundles while preserving
              fleet identity and trust. A passphrase-enabled scheduler maintains verified, rehearsed
              freshness and retention. Restore is an offline clean-directory maintenance action.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>The v1 topology</h2>
      <pre>
        <code>
          {`Fleet
├── Home site
│   ├── coordinator
│   └── connected execution nodes
├── Suitcase site A
└── Suitcase site B

Application graph
├── Home replica
├── Suitcase A replica
└── Suitcase B replica`}
        </code>
      </pre>
      <p>
        A <strong>node</strong> provides compute or storage inside a site. A <strong>site</strong>{' '}
        is a network and authority boundary. <strong>Home</strong> is the durable exchange hub and
        release authority coordinator. A <strong>Suitcase</strong> is a detachable site containing
        the local control, runtime, trust, and projection material required for offline use.
      </p>

      <h2>One graph, several authoring paths</h2>
      <p>
        Source projects, dashboard-created revisions, Catalog blueprints, and supported Compose
        imports all produce the same normalized application specification. Planning and Suitcase
        readiness therefore operate on the complete dependency, configuration, privilege, and data
        closure instead of copying an opaque container.
      </p>
      <p>
        Acceptance is deliberately evidence-scoped. A valid graph may still be blocked on one site
        by architecture, capacity, device access, networking, missing configuration, an unavailable
        artifact, or an unsafe data shape. The UI reports the affected promise rather than turning
        parser acceptance into a universal support badge.
      </p>

      <h2>Suitcase data modes</h2>
      <p>
        Placement and application data policy are separate. An administrator chooses automatic sync,
        manual sync, or no data sync for each selected application/site pair. Automatic and manual
        modes require a compatible portability report; no-sync creates an intentional site-local
        namespace. The Data page restores a verified cold Home snapshot into an isolated
        internal-network/read-only-root graph, checks exact artifacts and target configuration,
        exercises reconciliation and no-network builds, and projects the exact signed profile to the
        target. A structural classification without this proof cannot unlock sync. Opaque managed
        state uses a verified <strong>Follows one site</strong> transfer instead of pretending raw
        volumes can be merged.
      </p>
      <ul>
        <li>
          <strong>Syncs across sites:</strong> compare admitted SQLite row identities and uploaded
          file generations against a retained checkpoint. Generic v1 admission supports at most one
          declared SQLite database file; ambiguous changes become administrator conflicts.
        </li>
        <li>
          <strong>Follows one site:</strong> capture verified opaque cold snapshots from the current
          writer. Initial setup requires an explicit Home-or-Suitcase writer choice. A durable
          requested → capture → restore → target-ready → committed handoff uses an authority
          epoch/data-sequence CAS. The source remains quiesced until the target restores and passes
          health admission; failure or abort retains the old authority and retries source resume.
          Other sites remain recovery-only until commit.
        </li>
        <li>
          <strong>Site local:</strong> keep independent namespaces and never imply a merge.
        </li>
      </ul>

      <h2>Offline readiness</h2>
      <p>
        <strong>Ready offline</strong> is computed for one application release on one target. It
        requires the release and dependency closure, verified artifacts, target architecture and
        capacity, resolved identity/configuration, a tested access path, admitted data baseline, and
        the requested build/runtime mode. Access passes only after an authenticated administrator
        reaches the dashboard over a non-loopback private LAN or <code>.local</code> path; the proof
        is bound to the current boot/network and expires. Other useful states include needs setup,
        sync pending, awaiting authority, blocked by compatibility, and recovery-only.
      </p>

      <h2>Docked, away, and rejoining</h2>
      <ol>
        <li>
          <strong>Docked:</strong> pair once, select Keep on Suitcase, choose a data policy, and let
          signed events plus content-addressed artifacts converge. Run the access and readiness
          checks before departure.
        </li>
        <li>
          <strong>Away:</strong> applications and the admin surface start automatically on the local
          target. Local builds become immutable release candidates; Home continues serving its own
          replicas.
        </li>
        <li>
          <strong>Rejoining:</strong> resumable sync exchanges missing events, artifacts, data
          branches, and release candidates. Conflicts stay visible until an administrator resolves
          them; repeated delivery is safe.
        </li>
      </ol>

      <h2>Fleet history without centralizing every log</h2>
      <p>
        A separate cursor-based operational stream synchronizes semantic activity, completed build
        output, backup inventory and permitted backup artifacts, plus one-minute request aggregates.
        Raw requests, client identity fields, captures, container logs, and high-frequency resource
        samples remain local to the site that observed them. A no-sync application may advertise a
        local backup in inventory, but its backup bytes do not cross the site boundary.
      </p>

      <h2>Component operations</h2>
      <p>
        Operators can inspect desired/active/actual graph state, create a scale revision, restart
        one component, replace one stable instance, or run a declared profile operation. Targeted
        restart and replacement preserve unrelated healthy siblings. A disconnected Suitcase is
        administered through its local control surface, not by pretending Home still controls it.
      </p>
      <pre>
        <code>{`deploy component inspect <app> [--site <site-id>]
deploy component scale <app> <component> <instances>
deploy component restart <app> <component>
deploy component replace <app> <component> <instance-id>
deploy component operation <app> <component> <operation> --variables '{"key":"value"}'`}</code>
      </pre>

      <h2>Catalog and PostgreSQL boundaries</h2>
      <p>
        The Catalog supports exact signed blueprint releases, not every configuration an upstream
        project permits. Trust, installation, lifecycle, target, offline, Suitcase, and data
        compatibility are reported separately. Bundled validation blueprints prove the software
        contract; physical-device claims require matching release evidence.
      </p>
      <p>
        PostgreSQL is an ordinary graph component with an optional supported lifecycle profile.
        Backup, verified restore, generated private bindings, migrations, and version admission are
        distinct from disconnected multi-writer reconciliation, which v1 does not offer.
      </p>

      <h2>Release evidence still to collect</h2>
      <p>
        Physical macOS, Windows, Linux, amd64, and arm64 target runs; exact hotspot/AP behavior;
        abrupt-power testing; thermal and capacity measurements; real-trip drills; and 24-hour
        docked/away soaks are release evidence for particular builds and devices. They are not
        missing graph, Catalog, Suitcase, reconciliation, PostgreSQL, or recovery product code.
      </p>

      <h2>Use the v1 surfaces</h2>
      <ul>
        <li>
          Start with <Link to="/docs/configuration">deploy.yaml</Link>, then use{' '}
          <code>deploy validate</code> and <code>deploy plan</code> before deployment.
        </li>
        <li>
          Use <code>deploy catalog list</code>, <code>inspect</code>, and <code>install</code> for
          supported one-click application releases.
        </li>
        <li>
          Use Dashboard → Sites or <code>deploy suitcase</code> commands to pair, inspect, detach,
          synchronize, and revoke portable sites.
        </li>
        <li>
          Use <code>deploy component</code> commands to inspect graph state and perform targeted
          component operations on the site that owns the runtime.
        </li>
        <li>
          Use <code>deploy recovery readiness</code>, <code>create</code>, <code>verify</code>, and{' '}
          <code>restore</code> for the Home recovery boundary.
        </li>
        <li>
          Use <Link to="/docs/nodes">Nodes &amp; Placement</Link> for connected execution-agent
          workflows and their narrower placement boundary.
        </li>
      </ul>
    </article>
  );
}
