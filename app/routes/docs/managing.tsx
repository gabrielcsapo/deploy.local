import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Managing Deployments</h1>
      <p>
        Once an application is deployed, you can manage it from the{' '}
        <Link to="/dashboard">dashboard</Link>. Each deployment has tabs for overview, build logs,
        runtime logs, terminal, request analytics, resource metrics, history, and backups.
      </p>

      <h2>Container lifecycle</h2>
      <p>
        The <strong>Overview</strong> tab has controls for the running container. Which buttons
        appear depends on the container&apos;s current state:
      </p>
      <ul>
        <li>
          <strong>Stop</strong> &mdash; stops the container but keeps it and its volumes intact, so
          it can be started again later. Shown while the container is running.
        </li>
        <li>
          <strong>Start</strong> &mdash; starts a previously stopped container. Shown while the
          container is stopped.
        </li>
        <li>
          <strong>Restart</strong> &mdash; restarts the running container in place, without
          rebuilding it. Use this to clear in-memory state or pick up a configuration change that
          only needs a fresh process.
        </li>
        <li>
          <strong>Recreate</strong> &mdash; tears the container down and rebuilds it from the
          current image and settings. This is how environment variable, memory, volume, and port
          changes are applied (saving those settings triggers a recreate automatically), and it is
          useful when a container is in a bad state that a plain restart won&apos;t fix.
        </li>
      </ul>

      <h2>Environment variables</h2>
      <p>
        Set environment variables that are injected into the container at runtime. From the
        deployment&apos;s <strong>Overview</strong> tab, use the Environment Variables section to
        add key-value pairs. Changes take effect after a container restart (triggered automatically
        when you save).
      </p>
      <p>
        System environment variables (<code>PORT</code>, <code>PATH</code>,{' '}
        <code>NODE_VERSION</code>, <code>HOSTNAME</code>, <code>HOME</code>) are shown as read-only
        and cannot be overridden.
      </p>

      <h2>Memory limits</h2>
      <p>
        Restrict how much memory a container can use. From the <strong>Overview</strong> tab, select
        a preset (128MB, 256MB, 512MB, 1GB, 2GB, 4GB, 8GB) or enter a custom value using Docker
        memory notation (e.g. <code>384m</code>, <code>1.5g</code>). Changes restart the container.
      </p>

      <h2>Custom volumes</h2>
      <p>
        In addition to the automatic <code>/app/data</code> and <code>/app/uploads</code> mounts
        (see <Link to="/docs/deploying">Deploying Apps</Link>), you can mount arbitrary host paths
        into the container. From the <strong>Overview</strong> tab, add custom volume mounts with a
        host path, container path, and read-write or read-only mode. Changes restart the container.
      </p>

      <h2>GPU passthrough</h2>
      <p>
        If your server has NVIDIA GPUs and the{' '}
        <a
          href="https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/"
          target="_blank"
          rel="noopener noreferrer"
        >
          NVIDIA Container Toolkit
        </a>{' '}
        installed, you can enable GPU access for a deployment. Toggle{' '}
        <strong>GPU Passthrough</strong> in the <strong>Overview</strong> tab to pass all host GPUs
        into the container via <code>--gpus all</code>. This is useful for ML inference, CUDA
        workloads, or GPU-accelerated applications.
      </p>

      <h2>Privileged Docker access</h2>
      <p>
        Some apps (CI/CD runners, build servers, container orchestration tools) need to control the
        host&apos;s Docker daemon to spawn sibling containers. Enable{' '}
        <strong>Privileged Docker Access</strong> in the <strong>Overview</strong> tab to mount{' '}
        <code>/var/run/docker.sock</code> into the container. The deploy.json file can also declare
        <code>{`"privilegedDocker": true`}</code> to request this access at deploy time.
      </p>
      <p>
        <strong>Security warning:</strong> mounting the Docker socket gives the container
        root-equivalent access to the host. Anything inside the container can create, delete, or
        modify any container on the host (including escaping its own boundaries). Only enable this
        for apps you fully trust. The toggle requires explicit confirmation in the UI.
      </p>

      <h2>Container terminal</h2>
      <p>
        The <strong>Terminal</strong> tab opens an interactive shell session inside the running
        container. This is equivalent to running <code>docker exec -it &lt;container&gt; sh</code>.
        Use it to inspect files, debug issues, or run one-off commands. The terminal runs over
        WebSocket and uses xterm.js for rendering.
      </p>
      <p>
        You can open the same session from your own terminal with{' '}
        <Link to="/docs/cli">
          <code>deploy ssh &lt;name&gt;</code>
        </Link>{' '}
        &mdash; it bridges your local TTY to the container over the same exec/PTY protocol.
      </p>

      <h2>Build logs</h2>
      <p>
        The <strong>Build</strong> tab shows the Docker build output for each deployment. You can
        review the current build in progress or browse previous builds from the sidebar. Failed
        builds show the error output to help you diagnose the issue.
      </p>

      <h2>Runtime logs</h2>
      <p>
        The <strong>Logs</strong> tab streams live container output (stdout/stderr) in real time via
        WebSocket. Previous container logs from before the most recent redeploy are also preserved
        and viewable.
      </p>

      <h2>Request analytics</h2>
      <p>
        The <strong>Requests</strong> tab shows HTTP traffic to your deployment, including request
        method, path, status code, response time, and client IP. Use it to understand traffic
        patterns and identify slow endpoints. Request logs are retained for 90 days.
      </p>

      <h2>Resource metrics</h2>
      <p>
        The <strong>Resources</strong> tab displays CPU usage, memory consumption, network I/O, and
        disk I/O over time for each container. Metrics are sampled periodically and retained for 30
        days.
      </p>

      <h2>Deployment history</h2>
      <p>
        The <strong>History</strong> tab provides a full audit trail of all actions taken on a
        deployment: deploys, restarts, and deletions, with timestamps and the user who performed
        each action.
      </p>

      <h2>Backups</h2>
      <p>
        The <strong>Backups</strong> tab lets you manage volume backups for a deployment:
      </p>
      <ul>
        <li>
          <strong>Create a backup</strong> &mdash; snapshot the deployment&apos;s persistent volumes
          (<code>/app/data</code> and <code>/app/uploads</code>) as a <code>.tar.gz</code> file.
          Optionally add a label.
        </li>
        <li>
          <strong>Restore a backup</strong> &mdash; replace the current volume contents with a
          previous backup. The container is restarted after restore.
        </li>
        <li>
          <strong>Auto-backup</strong> &mdash; enable to automatically create a backup before each
          redeploy. Toggle this from the <strong>Overview</strong> tab or the Backups tab.
        </li>
        <li>
          <strong>Delete backups</strong> &mdash; remove old backups to reclaim disk space.
        </li>
      </ul>

      <h2>External backup (rsync)</h2>
      <p>
        The server-wide <Link to="/dashboard/settings">Settings</Link> page has an External Backup
        section that periodically mirrors the entire <code>.deploy-data/</code> directory to an
        external path using <code>rsync</code>. Configure the destination path and cron schedule to
        keep off-server backups of all deployments, the database, certificates, and volumes.
        Requires <code>rsync</code> to be installed on the server.
      </p>

      <h2>Discoverable services</h2>
      <p>
        Toggle <strong>Discoverable</strong> in the <strong>Overview</strong> tab to make a
        deployment visible on the network directory at <code>https://discover.local</code>. This is
        useful for sharing internal tools or services with others on the same network. You can also
        set <code>{'"discoverable": true'}</code> in your{' '}
        <Link to="/docs/configuration">
          <code>deploy.json</code>
        </Link>
        .
      </p>
    </article>
  );
}
