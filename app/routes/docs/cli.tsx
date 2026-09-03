import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>CLI Reference</h1>
      <p>
        The deploy.local CLI lets you deploy and manage applications from your terminal. All
        commands accept a <code>-u</code> flag to specify the server URL (defaults to{' '}
        <code>https://deploy.local</code>).
      </p>

      <h2>deploy</h2>
      <p>
        Deploy the current directory. Alias: <code>d</code>
      </p>
      <pre>
        <code>
          {`deploy
deploy -app my-app
deploy -u https://my-server.local:5000`}
        </code>
      </pre>
      <table>
        <thead>
          <tr>
            <th>Flag</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>-app, --application</code>
            </td>
            <td>Set the application name (defaults to directory name).</td>
          </tr>
          <tr>
            <td>
              <code>-u, --url</code>
            </td>
            <td>deploy.local server URL.</td>
          </tr>
        </tbody>
      </table>

      <h2>deploy list</h2>
      <p>
        List all your deployments. Alias: <code>ls</code>
      </p>
      <pre>
        <code>deploy list</code>
      </pre>

      <h2>deploy nodes enroll</h2>
      <p>
        Create a ten-minute, one-use enrollment for an execution node. Administrators can normally
        do this from <strong>Dashboard → Nodes</strong>; this command is available for automation.
      </p>
      <pre>
        <code>deploy nodes enroll --name imac</code>
      </pre>
      <p>
        For the normal web workflow and placement behavior, see{' '}
        <Link to="/docs/nodes">Nodes &amp; Placement</Link>.
      </p>

      <h2>deploy agent join</h2>
      <p>
        Redeem an enrollment code on another machine and install the background agent. On macOS, run
        it without sudo so its LaunchAgent can access Docker Desktop and mounted storage. Linux
        installs a systemd service as root.
      </p>
      <pre>
        <code>
          {`# macOS
deploy agent join https://deploy.local

# Linux
sudo deploy agent join https://deploy.local`}
        </code>
      </pre>

      <h2>deploy agent status</h2>
      <p>
        Check whether the local execution agent can authenticate with its coordinator and whether
        its background service is running.
      </p>
      <pre>
        <code>deploy agent status</code>
      </pre>

      <h2>deploy agent install</h2>
      <p>
        Reinstall the background service using this machine&apos;s existing enrollment. This does
        not create a new node or rotate its credential.
      </p>
      <pre>
        <code>deploy agent install</code>
      </pre>

      <h2>deploy suitcase target</h2>
      <p>
        Run this machine as an offline-capable suitcase target using Docker Engine or Docker
        Desktop. The command writes an inspectable Compose project and stable target identity to{' '}
        <code>~/.deploy/suitcase-target</code>. It uses persistent named volumes, so stopping or
        upgrading the target does not remove its deploy.local database, portable content, or build
        cache. After pairing, suitcase-core seeds the authoritative membership into that named state
        volume and performs docked synchronization in the background; the host target directory is
        only the bootstrap exchange and launcher configuration.
      </p>
      <pre>
        <code>{`# Review the resolved Compose project without starting Docker
deploy suitcase target compose

# First start (requires explicit acknowledgement of Docker socket access)
deploy suitcase target start --accept-docker-socket-risk

deploy suitcase target status
deploy suitcase target diagnose
deploy suitcase target upgrade --accept-docker-socket-risk
deploy suitcase target rollback --accept-docker-socket-risk
deploy suitcase target stop`}</code>
      </pre>
      <p>
        The core container mounts <code>/var/run/docker.sock</code> so it can build and control
        sibling application and volume-helper containers. Access to that socket is effectively
        administrative access to the Docker host; only run trusted deploy.local images and
        applications there. The target uses <code>restart: unless-stopped</code> and the helper
        image stays behind a Compose profile until a snapshot or volume inspection needs it.
      </p>
      <p>
        Start and upgrade resolve both images to immutable repository digests before activation. The
        target retains active and previous health-admitted A/B platform slots; a candidate that
        misses its health deadline is replaced automatically by the active slot. Use{' '}
        <code>rollback</code> for an explicit switch. Digest pinning is always enforced, but
        signature verification is only reported when you configure <code>--cosign-key</code> or a
        complete keyless <code>--cosign-certificate-identity</code> and{' '}
        <code>--cosign-certificate-oidc-issuer</code> policy. <code>--allow-mutable-images</code> is
        an explicit development-only escape hatch.
      </p>
      <p>
        HTTPS is published on port <code>8443</code> by default. Use <code>--https-port</code>,{' '}
        <code>--http-port</code>, <code>--target-dir</code>, or <code>--access-mode</code> to
        override the generated target. Run <code>diagnose</code> before a trip to see the concrete
        LAN URL and host instructions. Docker cannot create a physical Wi-Fi network: enable
        Internet Sharing on macOS, Mobile hotspot on Windows, or a host Wi-Fi hotspot on Linux.
        Native <code>.local</code> routing requires host integration; the IP URL remains the
        portable admin baseline, while application <code>.local</code> names still need that host
        integration.
      </p>

      <h2>deploy suitcase</h2>
      <p>
        Pair and operate a portable site. Pairing creation and revocation require a Home
        administrator; away, rejoin, sync, and local access commands run against the Suitcase core.
        No data sync is the safe pairing default.
      </p>
      <pre>
        <code>{`# Home: create a one-use pairing
deploy suitcase pair create --name "Travel" --policy none

# Suitcase: redeem it and check local access
deploy suitcase pair https://deploy.local --code <code>
deploy suitcase access

# Before leaving and after returning
deploy suitcase sync status
deploy suitcase away
deploy suitcase rejoin
deploy suitcase sync now

# Home administration
deploy suitcase topology
deploy suitcase access <site-id>
deploy suitcase writer plan <app-id> <target-site-id>
deploy suitcase writer move <app-id> <target-site-id>
deploy suitcase writer status <transfer-id>
deploy suitcase writer abort <transfer-id>
deploy suitcase revoke <site-id> --reason "lost device"
deploy suitcase remove-replica <app-id> <site-id> --confirm-data-loss`}</code>
      </pre>
      <p>
        Manual and automatic data sync require an admitted portability report. Removing a lost
        replica explicitly acknowledges that Home may never receive its away changes. Revocation
        rejects future sync credentials but does not erase a device that is already offline.
      </p>

      <h2>deploy component</h2>
      <p>
        Inspect desired, active, and actual graph state or perform a targeted component operation.
        Scaling creates an immutable revision; restart and instance replacement preserve unrelated
        healthy siblings. Use the control surface local to the site that owns the runtime.
      </p>
      <pre>
        <code>{`deploy component inspect <app> [--site <site-id>]
deploy component scale <app> <component> <instances> [--site <site-id>]
deploy component scale <app> <component> --site <site-id> --use-default
deploy component restart <app> <component>
deploy component replace <app> <component> <instance-id>
deploy component operation <app> <component> <operation> --variables '{"key":"value"}'`}</code>
      </pre>
      <p>
        A destructive scale plan is rejected unless you repeat it with{' '}
        <code>--confirm-destructive</code>. A Home-authored site count is a signed command that the
        named Suitcase admits and applies when it next syncs; <code>--use-default</code> removes
        that operational override. Use <code>component inspect --site</code> to verify that
        site&apos;s effective desired count and target-local runtime state. Profile operation
        variables must be a JSON object and remain distinct from the application&apos;s declared
        configuration values.
      </p>

      <h2>deploy catalog</h2>
      <p>
        Browse exact signed blueprint releases, preflight them against one target, and install them
        through the ordinary graph runtime. A Catalog entry&apos;s trust, lifecycle, target,
        offline, and data evidence are separate; listing an entry is not a universal hardware claim.
      </p>
      <pre>
        <code>{`deploy catalog list [query]
deploy catalog inspect <catalog-id> [release]
deploy catalog preflight <catalog-id> [release] --site <site-id>
deploy catalog install <catalog-id> [release] --name <app> --site <site-id>
deploy catalog installations
deploy catalog status <installation-id>
deploy catalog upgrade <installation-id> <release>
deploy catalog recovery-point <installation-id>
deploy catalog rollback <installation-id> <recovery-point-id>
deploy catalog retry <installation-id>
deploy catalog uninstall <installation-id>`}</code>
      </pre>
      <p>
        Use <code>--answers</code> with a JSON object for declared setup values. Uninstall retains
        managed data by default; <code>--delete-data</code> is the explicit destructive choice.
      </p>

      <h2>deploy recovery</h2>
      <p>
        Check release readiness and operate encrypted Home recovery bundles. Passphrases are
        prompted when omitted and should be stored separately from the bundle.
      </p>
      <pre>
        <code>{`deploy recovery readiness
deploy recovery create --output <server-bundle-path>
deploy recovery verify <server-bundle-path>
deploy recovery rehearse <bundle-id> <server-bundle-path>
deploy recovery list
deploy recovery support --output <server-support-path>
deploy recovery restore <server-bundle-path> <empty-server-data-directory>`}</code>
      </pre>
      <p>
        Bundle paths refer to Home. Rehearsal performs an isolated clean-directory restore and only
        records success after identity, credentials, key material, inventory, and application/data
        lineage validate. Restore is an offline maintenance boundary: stop the replacement Home
        first, restore into an empty data directory, and then start it with{' '}
        <code>DEPLOY_DATA_DIR</code>
        pointing at that directory.
      </p>

      <h2>deploy upgrade</h2>
      <p>
        Replace the current CLI with the exact platform build served by the coordinator. After
        upgrading an execution node, run <code>deploy agent install</code> to restart its background
        service with the new binary.
      </p>
      <pre>
        <code>{`deploy upgrade
deploy upgrade --check`}</code>
      </pre>

      <h2>deploy logs</h2>
      <p>
        Stream logs from a running deployment. Alias: <code>l</code>
      </p>
      <pre>
        <code>deploy logs -app my-app</code>
      </pre>
      <table>
        <thead>
          <tr>
            <th>Flag</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>-app, --application</code>
            </td>
            <td>Name of the deployment to stream logs from (required).</td>
          </tr>
        </tbody>
      </table>

      <h2>deploy ssh</h2>
      <p>
        Open an interactive shell inside a running deployment&apos;s container, straight from your
        terminal. This bridges your local TTY to the same exec/PTY session the dashboard{' '}
        <strong>Terminal</strong> tab uses, so full-screen programs (<code>top</code>,{' '}
        <code>vim</code>) render correctly and terminal resizes are forwarded. Alias:{' '}
        <code>exec</code>. The deployment name is passed as a positional argument.
      </p>
      <pre>
        <code>deploy ssh my-app</code>
      </pre>
      <p>
        Requires you to be logged in (<code>deploy login</code> or <code>deploy register</code>).
      </p>

      <h2>deploy delete</h2>
      <p>
        Stop and remove a deployment. Alias: <code>rm</code>
      </p>
      <pre>
        <code>deploy delete -app my-app</code>
      </pre>
      <table>
        <thead>
          <tr>
            <th>Flag</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>-app, --application</code>
            </td>
            <td>Name of the deployment to delete (required).</td>
          </tr>
        </tbody>
      </table>

      <h2>deploy open</h2>
      <p>
        Open a deployment in your browser. Alias: <code>o</code>
      </p>
      <pre>
        <code>deploy open -app my-app</code>
      </pre>
      <table>
        <thead>
          <tr>
            <th>Flag</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>-app, --application</code>
            </td>
            <td>Name of the deployment to open (required).</td>
          </tr>
        </tbody>
      </table>

      <h2>deploy validate</h2>
      <p>
        Validate the current application locally without logging in or contacting a deploy.local
        server. The command validates <code>deploy.yaml</code> and compiles it into the same
        normalized v1 application graph used during deployment.
      </p>
      <pre>
        <code>{`deploy validate

✓ deploy.yaml is valid
  API: deploy.local/v1
  Digest: sha256:...
  Graph: 2 components / 3 instances, 1 route, 1 resource, 0 jobs
  Components: db, web x2
  Configuration: 2 declared, 2 required, 1 secret, 1 site-scoped`}</code>
      </pre>
      <p>
        Validation rejects duplicate or unknown fields, malformed values, invalid graph references,
        unsupported YAML features. Errors include the path to the field that needs attention, and
        the command exits nonzero for use in CI. This is structural validation; use{' '}
        <code>deploy plan</code> for the semantic diff. Host capacity and live runtime admission
        remain server-side deployment checks.
      </p>

      <h2>deploy plan</h2>
      <p>
        Compare the validated local application graph with the server&apos;s current desired
        revision. This is a read-only operation: it fetches the normalized application
        specification, plans the semantic changes locally, and does not upload source files or
        change runtime state.
      </p>
      <pre>
        <code>{`deploy plan
deploy plan --app notes

Plan for notes
  Current: sha256:...
  Desired: sha256:... (deploy.yaml)

  • component-scale: Scale component "web" from 1 to 2 desired instances

  Approval: not required  Restart: not required  Destructive: no  Blocked: no`}</code>
      </pre>
      <p>
        The application name defaults to the current directory name. You must be logged in and own
        the server-side application. The summary calls out approval, restart, destructive, and
        blocked changes before you choose whether to deploy.
      </p>

      <h2>deploy files</h2>
      <p>
        List all files that would be bundled for deployment. This is useful for checking what your{' '}
        <code>.gitignore</code> excludes before deploying. The selected <code>deploy.yaml</code>
        manifest is always included, even if it is Git-ignored. Alias: <code>f</code>
      </p>
      <pre>
        <code>deploy files</code>
      </pre>

      <h2>deploy schema</h2>
      <p>
        Copy <code>deploy.v1.schema.json</code> for editor autocompletion and validation of the
        versioned <Link to="/docs/configuration">deploy.yaml</Link> application graph.
      </p>
      <pre>
        <code>deploy schema</code>
      </pre>

      <h2>deploy register</h2>
      <p>
        Create a new user account on the server. Alias: <code>r</code>
      </p>
      <pre>
        <code>deploy register</code>
      </pre>

      <h2>deploy login</h2>
      <p>
        Authenticate with the server. Credentials are saved to <code>~/.deployrc</code>.
      </p>
      <pre>
        <code>deploy login</code>
      </pre>

      <h2>deploy logout</h2>
      <p>Log out and invalidate your session token.</p>
      <pre>
        <code>deploy logout</code>
      </pre>

      <h2>deploy whoami</h2>
      <p>
        Show the currently logged-in user. Aliases: <code>who</code>, <code>me</code>
      </p>
      <pre>
        <code>deploy whoami</code>
      </pre>

      <h2>deploy version</h2>
      <p>
        Show the build installed on this machine. Every build is stamped with the commit it was
        built from and the time it was built, so rebuilding the same commit still yields a distinct
        version. Alias: <code>v</code>
      </p>
      <pre>
        <code>
          {`deploy version
deploy version --json

deploy 1.0.0+c4d1a04.20260724T173839Z
  commit:   c4d1a04858ccef12a3b4b81277fdc0c7c1efceee
  built:    2026-07-24T17:38:39Z
  platform: darwin-arm64
  runtime:  node 26.1.0`}
        </code>
      </pre>

      <h2>deploy upgrade</h2>
      <p>
        Replace the installed CLI with the build the server serves. The binary for your platform is
        downloaded, verified against the SHA-256 in the server's manifest, run once as a smoke test,
        and only then swapped into place — a failed download never leaves you without a working{' '}
        <code>deploy</code>. Alias: <code>update</code>
      </p>
      <p>
        Versions are compared for equality rather than order: the CLI's job is to match its server,
        so a server rolled back to an older build pulls the CLI back with it. The server publishes
        what it serves at <code>GET /cli/version</code>; both that and the binaries come from{' '}
        <code>pnpm build:cli</code> on the server.
      </p>
      <pre>
        <code>
          {`deploy upgrade
deploy upgrade --check   # exits 1 if the server has a different build
deploy upgrade --force   # reinstall even when the versions match`}
        </code>
      </pre>
      <p>
        Upgrading in place needs write access to the installed binary. If it lives somewhere
        root-owned such as <code>/usr/local/bin</code>, re-run the command with <code>sudo</code>.
      </p>

      <h2>deploy server</h2>
      <p>
        Start the deploy.local server. This launches the HTTPS server, HTTP redirect, API, and web
        dashboard in a single process. Alias: <code>start</code>
      </p>
      <pre>
        <code>
          {`deploy server
deploy server -p 8443`}
        </code>
      </pre>
      <table>
        <thead>
          <tr>
            <th>Flag</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>-p, --port</code>
            </td>
            <td>HTTPS port to listen on (default: 443, falls back to 8443).</td>
          </tr>
        </tbody>
      </table>

      <h2>Global flags</h2>
      <table>
        <thead>
          <tr>
            <th>Flag</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>-u, --url</code>
            </td>
            <td>
              Server URL (default: <code>https://deploy.local</code>, or the value in{' '}
              <code>~/.deployrc</code>).
            </td>
          </tr>
          <tr>
            <td>
              <code>-h, --help</code>
            </td>
            <td>Show usage information.</td>
          </tr>
        </tbody>
      </table>

      <h2>Command aliases</h2>
      <p>All commands have short aliases for convenience:</p>
      <table>
        <thead>
          <tr>
            <th>Alias</th>
            <th>Command</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>d</code>
            </td>
            <td>deploy</td>
          </tr>
          <tr>
            <td>
              <code>ls</code>
            </td>
            <td>list</td>
          </tr>
          <tr>
            <td>
              <code>l</code>
            </td>
            <td>logs</td>
          </tr>
          <tr>
            <td>
              <code>exec</code>
            </td>
            <td>ssh</td>
          </tr>
          <tr>
            <td>
              <code>rm</code>
            </td>
            <td>delete</td>
          </tr>
          <tr>
            <td>
              <code>o</code>
            </td>
            <td>open</td>
          </tr>
          <tr>
            <td>
              <code>f</code>
            </td>
            <td>files</td>
          </tr>
          <tr>
            <td>
              <code>r</code>
            </td>
            <td>register</td>
          </tr>
          <tr>
            <td>
              <code>who</code>, <code>me</code>
            </td>
            <td>whoami</td>
          </tr>
          <tr>
            <td>
              <code>v</code>
            </td>
            <td>version</td>
          </tr>
          <tr>
            <td>
              <code>update</code>
            </td>
            <td>upgrade</td>
          </tr>
          <tr>
            <td>
              <code>start</code>
            </td>
            <td>server</td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}
