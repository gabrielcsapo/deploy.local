import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Architecture</h1>
      <p>
        deploy.local separates durable application intent from changing runtime state. A versioned
        application graph describes what should exist; a site coordinator materializes that graph,
        admits it through health checks, and records the exact revision that became active.
      </p>

      <div className="not-prose my-7 rounded-xl border border-success/25 bg-success/8 p-4">
        <span className="badge badge-success">v1 topology</span>
        <p className="mt-3 text-sm leading-relaxed text-text-secondary">
          Complete node-local application graphs execute on Home, selected Docker-backed Suitcase
          sites, and connected execution agents. A connected agent returns one primary route to
          Home; a node is compute inside a site, while a Suitcase is a detachable authority and
          network boundary with its own local control surface.
        </p>
      </div>

      <h2>System overview</h2>
      <pre>
        <code>
          {`deploy.yaml / Catalog blueprint / supported Compose
                         │ validate + normalize
                         ▼
             immutable ApplicationSpec revision
                         │ plan + materialize
              ┌──────────┴──────────┐
              ▼                     ▼
        Home coordinator      Suitcase coordinator
        Docker + routing      Docker + local control
              │                     │
              └──── signed events + content-addressed artifacts ────┘

Home may also dispatch a complete node-local graph to one connected agent.`}
        </code>
      </pre>

      <h2>The application graph</h2>
      <p>
        A repository <code>deploy.yaml</code>, verified Catalog release, or the supported Compose
        subset compiles into the same normalized
        <code>ApplicationSpec</code>. Canonical JSON gives each revision a stable digest independent
        of YAML comments and formatting. The source and normalized definition are retained;
        component and resource rows are operational projections, not the only durable copy.
      </p>
      <p>
        The graph contains build- or image-backed components, fixed instance groups, private
        interfaces, public routes, resources, jobs, and typed configuration references. A PostgreSQL
        profile adds lifecycle contracts to an ordinary component; it does not create a hidden
        database service. Resolved configuration values remain outside the graph and secret values
        stay encrypted and redacted from exports.
      </p>

      <h2>Desired, active, and actual state</h2>
      <p>
        A new immutable revision first becomes <strong>desired</strong>. The executor computes a
        semantic plan, resolves configuration, creates or reuses component instances, runs scoped
        jobs, verifies health, and only then promotes the revision to <strong>active</strong>.
        Runtime observations are recorded separately as <strong>actual</strong> state. If admission
        fails, the previous active revision and traffic remain intact.
      </p>
      <p>
        The dashboard and component API expose that distinction. Scaling creates another immutable
        revision; restart and instance replacement are targeted runtime operations that preserve
        unrelated healthy siblings. See the <Link to="/docs/cli">CLI reference</Link> for the
        matching component commands.
      </p>

      <h2>Home, nodes, and sites</h2>
      <p>
        Home owns fleet identity, durable release exchange, user authentication, its local TLS and
        mDNS surface, and the recovery boundary. Connected Linux and macOS execution agents enroll
        with short-lived one-use codes, heartbeat outward, claim authenticated encrypted jobs, and
        can run a complete graph on one node while Home retains the primary public address.
      </p>
      <p>
        A Suitcase is different: it is a paired site with its own identity, event log, content
        store, projected desired state, local Docker executor, and offline administrator surface.
        While docked, Home and Suitcase exchange signed events and verified content-addressed
        artifacts. While away, both sites keep operating and can produce release candidates. Rejoin
        is idempotent and preserves conflicts or competing candidates for administrator review.
      </p>

      <h2>Suitcase projection and materialization</h2>
      <ol>
        <li>Home publishes an immutable desired revision and the selected replica policy.</li>
        <li>The Suitcase verifies event origin, sequence, signature, and referenced artifacts.</li>
        <li>
          The projector records desired state without overwriting the last admitted active state.
        </li>
        <li>The local executor restores an admitted data baseline, then converges the graph.</li>
        <li>Health admission promotes the revision and emits materialization evidence.</li>
      </ol>
      <p>
        Catalog operations use the same path. Their desired event carries an operation ID and
        attempt; the target returns one exact completion record for that attempt. Removal and
        recovery likewise remain pending until target-local materialization reports a terminal
        result.
      </p>

      <h2>Data authority and reconciliation</h2>
      <p>
        Placement does not imply data synchronization. Every kept application selects no data sync,
        manual sync, or automatic sync and one of three data topologies:
      </p>
      <ul>
        <li>
          <strong>Site local</strong> gives every site an intentional independent namespace.
        </li>
        <li>
          <strong>Syncs across sites</strong> exchanges admitted semantic SQLite and uploaded-file
          changes against a common checkpoint. Conflicting rows or file generations are retained for
          an administrator instead of being guessed away.
        </li>
        <li>
          <strong>Follows one site</strong> transfers verified opaque cold snapshots. Exactly one
          site is the writer; other replicas are recovery-only until authority moves.
        </li>
      </ul>
      <p>
        Generic SQLite reconciliation currently admits at most one declared SQLite database file
        plus declared uploaded-file paths. Unsafe schemas, unknown paths, databases without the
        required reconciliation identity, and unsupported opaque multi-writer state fail closed.
      </p>

      <h2>Routing and local access</h2>
      <p>
        At Home, the edge process terminates TLS, advertises <code>*.local</code> names, and routes
        to coordinator-owned containers or an agent relay. A Suitcase has a separate local access
        contract so its administrator surface and applications remain reachable while disconnected.
        The Docker target exposes the runtime ports, but host Wi-Fi hotspot creation, native mDNS,
        and platform firewall setup are host responsibilities in v1.
      </p>

      <h2>Durability and recovery</h2>
      <p>
        Runtime databases, signed fleet events, site credentials, application revisions, data
        checkpoints, recovery points, and artifact references live under the configured deploy data
        directory. Project bundles and graph artifacts are retained by digest so a selected Suitcase
        can build without reaching Home.
      </p>
      <p>
        Home recovery bundles are encrypted and independently verifiable. Rehearsal restores into an
        isolated empty directory and proves inventory, fleet identity, trust and signing material,
        application/data lineage, and active Suitcase credential hashes before it records success.
        When a dedicated recovery passphrase is configured, the maintenance scheduler creates,
        verifies, rehearses, and prunes bundles to keep that boundary fresh. Restore targets an
        empty server data directory while Home is stopped; it is intentionally not an in-place
        mutation of a running coordinator. Fleet identity and revocation state must survive recovery
        so an old or lost Suitcase cannot silently create a second lineage.
      </p>

      <h2>Capability is not evidence</h2>
      <p>
        Parser support, runtime implementation, target compatibility, offline readiness, and
        physical-device evidence are separate facts. The v1 Docker target can run on Linux
        containers and Docker Desktop on macOS or Windows, but that does not claim a custom board
        image, automated Wi-Fi access point, abrupt-power tolerance, or tested performance on every
        device. Readiness is computed for an exact release, target, data shape, and evidence set;
        the access dimension requires an authenticated non-loopback administrator client and is
        invalidated when its boot/network evidence is stale.
      </p>

      <p>
        Continue with <Link to="/docs/roadmap">v1 Support &amp; Workflows</Link> for the support
        matrix, or <Link to="/docs/nodes">Nodes &amp; Placement</Link> for the connected-agent
        boundary.
      </p>
    </article>
  );
}
