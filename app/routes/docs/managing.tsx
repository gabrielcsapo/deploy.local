import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Operate applications</h1>
      <p>
        Open <Link to="/dashboard/apps">Applications</Link> and select an application. Its
        contextual sidebar contains Overview, Deployments, Logs, Activity and Settings.
      </p>
      <h2>Services and storage</h2>
      <p>
        Overview lists the application&apos;s services and managed resources. Expand a row to
        inspect its configuration and runtime state. Configuration needed and unavailable states
        identify services that are not ready; an application status does not replace these
        individual service states.
      </p>
      <h2>Application configuration</h2>
      <p>
        Components, environment variables, ports, runtime requirements and managed resources belong
        in the repository&apos;s <code>deploy.yaml</code>. Keep these changes in source control and
        deploy the resulting revision. See{' '}
        <Link to="/docs/configuration">Application configuration</Link>
        for the supported schema and configuration references.
      </p>
      <h2>Deployment computer and host mounts</h2>
      <p>
        Settings selects the deployment computer and configures custom host directory mounts. Saving
        a different computer pins future deployments to it. When available, Move now uses the
        retained source artifact to move the application without another upload. Host mount paths
        refer to the selected computer and must exist there. Review pending mount changes before
        applying them; recreating a container can interrupt the application.
      </p>
      <p>
        See <Link to="/docs/nodes">Machines and placement</Link> for enrollment and data movement.
      </p>
      <h2>Deployment output</h2>
      <p>
        Deployments shows build attempts, timestamps and outcomes. Select an attempt to read its
        build output or runtime logs. Failed attempts retain their output. Configuration history
        opens in a disclosure below the workbench.
      </p>
      <h2>Runtime logs</h2>
      <p>
        Logs streams the selected runtime target&apos;s output. Use target, level and text filters
        to narrow the stream. Pause scrolling to inspect output; copy or download the filtered
        lines. If the target is unavailable, use Retry logs after restoring its runtime connection.
        The application-wide Logs destination combines streams from multiple applications.
      </p>
      <h2>Request activity and measurements</h2>
      <p>
        Activity shows request counts, latency, status codes and request details for a selected time
        range. Missing telemetry remains unavailable. Measurement colors identify the signal: CPU is
        blue, memory teal, traffic violet and latency silver. Status colors separately identify
        success, warning and failure. The <Link to="/dashboard/design-system">design system</Link>
        defines these mappings.
      </p>
      <h2>Container terminal</h2>
      <p>
        Use <code>deploy ssh &lt;name&gt;</code> from your terminal for an interactive container
        session. See the <Link to="/docs/cli">CLI reference</Link> for command options.
      </p>
      <h2>Backups</h2>
      <p>
        Application Settings controls managed volume backups. Workspace Settings → Backups
        configures the coordinator&apos;s external backup destination and schedule, and provides
        Test destination and Backup now actions. Check the recorded result before relying on a
        backup. Custom host mounts and managed application resources have different data contracts;
        review the application configuration before moving or removing data.
      </p>
      <h2>Remove an application</h2>
      <p>
        Delete this app is in application Settings. Review the application name, managed resources
        and confirmation before removing it.
      </p>
      <h2>Shared applications</h2>
      <p>
        <Link to="/dashboard/discover">Shared apps</Link> lists applications currently published for
        guest access. An empty list means no applications are published there.
      </p>
    </article>
  );
}
