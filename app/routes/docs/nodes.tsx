import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Nodes &amp; Placement</h1>
      <p>
        A deploy.local fleet has one <strong>coordinator</strong> and any number of optional
        <strong> execution nodes</strong>. You still deploy to <code>deploy.local</code>; the
        coordinator chooses the configured node, moves managed data when necessary, and keeps the
        application reachable at the same <code>*.local</code> hostname.
      </p>

      <h2>What runs where</h2>
      <table>
        <thead>
          <tr>
            <th>Coordinator</th>
            <th>Execution node</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Dashboard, API, users, and deployment metadata</td>
            <td>Docker builds and containers assigned to that node</td>
          </tr>
          <tr>
            <td>
              Advertises <code>deploy.local</code>, <code>discover.local</code>, and every app
              hostname
            </td>
            <td>Does not advertise mDNS names</td>
          </tr>
          <tr>
            <td>Terminates TLS and routes application traffic over the LAN</td>
            <td>Exposes an agent-managed relay to its local Docker port</td>
          </tr>
          <tr>
            <td>Keeps centralized backups and retained source artifacts</td>
            <td>Stores the active managed volumes for its applications</td>
          </tr>
        </tbody>
      </table>
      <p>
        Agents connect outbound to the coordinator for jobs, terminal sessions, logs, and status.
        The coordinator connects to the agent&apos;s advertised private LAN address only for
        application traffic.
      </p>
      <p>
        A <code>deploy.yaml</code> job carries the admitted graph and resolved site configuration in
        the existing encrypted job envelope. The agent verifies the downloaded manifest, creates all
        component instances on one private network, runs scoped jobs, admits health, and returns the
        primary route relay. Components are not spread across several execution nodes in v1.
      </p>

      <h2>Enroll a node from the dashboard</h2>
      <ol>
        <li>
          Open <Link to="/dashboard/nodes">Dashboard → Nodes</Link> as the fleet administrator.
        </li>
        <li>
          Name the machine and create a one-use enrollment. The code expires after ten minutes.
        </li>
        <li>Install the CLI on the new machine and run the join command shown by the dashboard.</li>
      </ol>
      <pre>
        <code>{`# macOS — use your normal desktop account
deploy agent join https://deploy.local

# Linux
sudo deploy agent join https://deploy.local`}</code>
      </pre>
      <p>
        macOS uses a per-user LaunchAgent so the agent can reach Docker Desktop or Colima and
        mounted storage. Linux uses a systemd service. Enrollment credentials are stored on the node
        and can only be revoked from the administrator&apos;s Nodes page.
      </p>

      <h2>Docker and node status</h2>
      <p>
        The Nodes page shows heartbeat state, agent version, CPU, memory, Docker availability,
        running deploy.local containers, and active agent work. During a job it reports stages such
        as source download, volume extraction, image build, container start, and health check, with
        recent messages and byte progress where available.
      </p>
      <p>
        On macOS, Docker must be running in the same user session as the LaunchAgent. If you use
        Colima, start the Colima VM before restarting the agent.
      </p>

      <h2>Choose the default node</h2>
      <p>
        The first deployment requires a default node. Choose <strong>Make default</strong> on the
        Nodes page. Future applications deploy there automatically, so the CLI never asks you to
        select a machine for every push.
      </p>

      <h2>Place an individual application</h2>
      <p>
        Open the application&apos;s <strong>Settings</strong> tab and choose its Deployment node.
        Saving the selection pins future deploys to that machine. The next <code>deploy</code> moves
        the application before building the new release.
      </p>
      <p>
        Use <strong>Move now</strong> to move the current application without uploading a new source
        bundle. This requires at least one retained source artifact from an earlier deployment.
      </p>

      <h2>Managed-volume migration</h2>
      <p>
        For the legacy <code>/app/data</code> and <code>/app/uploads</code> contract, changing the
        active node performs these steps:
      </p>
      <ol>
        <li>Rejects overlapping deploys for the application while it is migrating.</li>
        <li>
          Backs up <code>/app/data</code> and <code>/app/uploads</code> on the source node.
        </li>
        <li>Takes custody of the compressed archive on the coordinator.</li>
        <li>
          Streams and extracts it on the destination, reporting transfer and extraction progress.
        </li>
        <li>Builds and health-checks the destination container.</li>
        <li>
          Switches the route, then removes the previous node&apos;s container while retaining its
          volumes.
        </li>
      </ol>
      <p>
        The old route remains active until the destination becomes healthy. Application pages show a
        migration banner, and the Build tab preserves the full lifecycle log.
      </p>
      <p>
        A graph&apos;s managed resources persist in the agent backup namespace and are included in
        remote backups, but generic cross-node graph-volume relocation is not implied by this legacy
        archive path. Place a stateful graph before its first deployment or use its declared
        profile/recovery workflow. Custom host mounts refer to paths on the selected execution node
        and must exist there before deployment.
      </p>

      <h2>Hostnames and traffic</h2>
      <p>
        Execution nodes never compete for <code>deploy.local</code> or application mDNS names. The
        coordinator advertises <code>medius.local</code>, terminates its certificate, then proxies
        the request to the active node&apos;s agent relay. Moving an app changes the backend route,
        not the URL your household uses.
      </p>
      <p>
        Agents advertise a private physical-interface address in their heartbeat and avoid Docker,
        Colima, Tailscale, and tunnel interfaces. The coordinator verifies a newly deployed relay is
        reachable before declaring the deployment successful.
      </p>

      <h2>Remote logs and terminal</h2>
      <p>
        The application Logs and Terminal tabs continue to work for remote containers. Terminal
        input, output, and resize events travel over the authenticated agent control channel, so the
        coordinator does not need access to the remote Docker socket. The same path powers{' '}
        <Link to="/docs/cli">
          <code>deploy ssh &lt;name&gt;</code>
        </Link>
        .
      </p>

      <h2>Backups across the fleet</h2>
      <p>
        Manual, pre-deploy, and scheduled backups run on the node that owns the application. Remote
        agents upload their archives to the coordinator&apos;s normal backup tree. The
        coordinator&apos;s external rsync schedule can then copy the database, certificates,
        retained source, and backups for the entire fleet to another disk or mounted destination.
      </p>

      <h2>Upgrade or repair an agent</h2>
      <pre>
        <code>{`deploy upgrade
deploy agent install
deploy agent status`}</code>
      </pre>
      <p>
        <code>deploy upgrade</code> matches the CLI to the build served by its coordinator. Re-run
        <code>deploy agent install</code> to restart the background service with that binary; it
        keeps the existing enrollment.
      </p>

      <h2>Remove access</h2>
      <p>
        Revoke an agent from <Link to="/dashboard/nodes">Dashboard → Nodes</Link>. Revocation is
        immediate and its credential cannot reconnect. Applications and backup archives are not
        deleted automatically; move or delete assigned applications first when decommissioning a
        machine.
      </p>

      <h2>Next steps</h2>
      <ul>
        <li>
          <Link to="/docs/managing">Managing Deployments</Link> for lifecycle, data, and
          observability.
        </li>
        <li>
          <Link to="/docs/architecture">Architecture</Link> for routing and control-plane details.
        </li>
        <li>
          <Link to="/docs/troubleshooting">Troubleshooting</Link> for offline nodes, Docker, and
          routing.
        </li>
      </ul>
    </article>
  );
}
