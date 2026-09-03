import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Troubleshooting</h1>

      <h2>TLS certificate errors in the browser</h2>
      <p>
        If you see &ldquo;Your connection is not private&rdquo; or similar TLS warnings, you need to
        trust the deploy.local CA certificate. Download it and add it to your system trust store:
      </p>
      <pre>
        <code>curl -O http://deploy.local/ca.crt</code>
      </pre>
      <ul>
        <li>
          <strong>macOS:</strong> Open the file, add to Keychain Access, then set Trust to
          &ldquo;Always Trust.&rdquo;
        </li>
        <li>
          <strong>Linux:</strong> Copy to <code>/usr/local/share/ca-certificates/</code> and run{' '}
          <code>sudo update-ca-certificates</code>.
        </li>
      </ul>
      <p>
        After trusting the cert, restart your browser. If you deployed new apps since the last cert
        download, the server automatically regenerates the certificate to include new hostnames.
      </p>

      <h2>Cannot resolve .local hostnames</h2>
      <p>
        deploy.local uses mDNS (multicast DNS) to resolve <code>.local</code> hostnames on the local
        network. If hostnames like <code>deploy.local</code> or <code>my-app.local</code> don&apos;t
        resolve:
      </p>
      <ul>
        <li>
          <strong>macOS:</strong> mDNS works out of the box. Make sure you&apos;re on the same
          network as the server.
        </li>
        <li>
          <strong>Linux:</strong> Install <code>avahi-daemon</code> and <code>libnss-mdns</code>{' '}
          (e.g. <code>sudo apt install avahi-daemon libnss-mdns</code>). Ensure <code>mdns</code> is
          listed in <code>/etc/nsswitch.conf</code> for the <code>hosts</code> line.
        </li>
        <li>
          <strong>Windows:</strong> Install{' '}
          <a href="https://support.apple.com/bonjour" target="_blank" rel="noopener noreferrer">
            Bonjour Print Services
          </a>{' '}
          or use WSL with avahi.
        </li>
      </ul>

      <h2>openssl not found</h2>
      <p>
        The server requires <code>openssl</code> to generate TLS certificates on startup. If you see
        &ldquo;openssl is required but not found,&rdquo; install it:
      </p>
      <pre>
        <code>
          {`# macOS (usually pre-installed)
brew install openssl

# Debian/Ubuntu
sudo apt install openssl

# Alpine
apk add openssl`}
        </code>
      </pre>

      <h2>Port 443 unavailable</h2>
      <p>
        If port 443 is already in use or requires root permissions, the server automatically falls
        back to port 8443. You&apos;ll see a warning in the console:
      </p>
      <pre>
        <code>Port 443 unavailable (EADDRINUSE), falling back to port 8443</code>
      </pre>
      <p>
        To use port 443, either stop the process occupying it, or run the server with elevated
        permissions. You can also set a custom port via the <code>HTTPS_PORT</code> environment
        variable.
      </p>

      <h2>App fails to start after deployment</h2>
      <p>If a deployment builds successfully but the container exits immediately:</p>
      <ul>
        <li>
          Check the <strong>Logs</strong> tab in the dashboard for error output.
        </li>
        <li>
          Make sure your app listens on <code>process.env.PORT</code> (not a hardcoded port).
        </li>
        <li>
          For Node.js apps, verify your <code>package.json</code> has a valid <code>start</code>{' '}
          script.
        </li>
        <li>
          Use the <strong>Terminal</strong> tab to open a shell in the container and inspect the
          file system.
        </li>
        <li>
          Check the <strong>Build</strong> tab for any build warnings that may indicate missing
          dependencies.
        </li>
      </ul>

      <h2>Cannot access app from another machine</h2>
      <p>If the app works on the server machine but not from other devices on the network:</p>
      <ul>
        <li>
          Ensure both machines are on the same local network (mDNS doesn&apos;t work across
          subnets).
        </li>
        <li>Check that the server&apos;s firewall allows traffic on ports 80 and 443 (or 8443).</li>
        <li>
          Verify mDNS is working on the client (see &ldquo;Cannot resolve .local hostnames&rdquo;
          above).
        </li>
        <li>Make sure the client has trusted the CA certificate.</li>
      </ul>

      <h2>Build fails with &ldquo;unknown type&rdquo;</h2>
      <p>deploy.local needs one of these files in your project root to detect the project type:</p>
      <ul>
        <li>
          <code>Dockerfile</code> &mdash; Docker container
        </li>
        <li>
          <code>package.json</code> &mdash; Node.js application
        </li>
        <li>
          <code>index.html</code> &mdash; static site
        </li>
      </ul>
      <p>
        Use <code>deploy files</code> to verify which files are being bundled. If a required file is
        missing from the bundle, check your <code>.gitignore</code> and the{' '}
        <code>components.*.build.ignore</code> field in{' '}
        <Link to="/docs/configuration">
          <code>deploy.yaml</code>
        </Link>
        .
      </p>

      <h2>CLI cannot connect to server</h2>
      <p>If the CLI shows a connection error:</p>
      <ul>
        <li>
          Check that the server is running (<code>pnpm start</code> or <code>deploy server</code>).
        </li>
        <li>
          Verify the server URL in <code>~/.deployrc</code> is correct.
        </li>
        <li>
          Try specifying the URL explicitly: <code>deploy list -u https://deploy.local</code>.
        </li>
        <li>
          If using a self-signed cert, ensure your system trusts the CA (the CLI uses the
          system&apos;s certificate store).
        </li>
      </ul>

      <h2>rsync backup fails</h2>
      <p>
        Check the backup status in <Link to="/dashboard/settings">Settings</Link> for error details.
        Common causes:
      </p>
      <ul>
        <li>
          <code>rsync</code> is not installed on the server.
        </li>
        <li>The destination path doesn&apos;t exist or the parent directory is not mounted.</li>
        <li>Insufficient permissions to write to the destination.</li>
      </ul>

      <h2>Execution node is offline</h2>
      <ul>
        <li>
          Run <code>deploy agent status</code> on the node.
        </li>
        <li>
          Upgrade and restart it with <code>deploy upgrade</code> followed by{' '}
          <code>deploy agent install</code>.
        </li>
        <li>On macOS, run the agent as the enrolled desktop user, not with sudo.</li>
        <li>
          Check that the node can reach <code>https://deploy.local</code> and that its credential
          has not been revoked.
        </li>
      </ul>

      <h2>Docker is unavailable to the agent</h2>
      <p>
        A Docker CLI on your shell&apos;s PATH does not guarantee the background service can reach
        the daemon. Start Docker Desktop or Colima in the same macOS user session, then reinstall
        the agent service. The Nodes page shows the exact socket or API error reported by the agent.
      </p>

      <h2>Remote app builds but its hostname does not load</h2>
      <p>
        The coordinator advertises the hostname and must be able to reach the node&apos;s private
        LAN address. Check the failure message for the attempted address and port. An address of{' '}
        <code>127.0.0.1</code> means the agent is outdated; upgrade and reinstall it so its next
        heartbeat advertises a physical-interface address. Also allow incoming connections if the
        node&apos;s firewall prompts for the deploy agent.
      </p>
      <pre>
        <code>dns-sd -G v4 my-app.local</code>
      </pre>
      <p>
        DNS should resolve to the coordinator, not the execution node. The coordinator then proxies
        the request to the active node&apos;s relay.
      </p>

      <h2>Application is stuck migrating</h2>
      <ul>
        <li>
          Open the Build tab and Dashboard → Nodes to identify the active backup, restore, or build
          stage.
        </li>
        <li>Confirm both nodes are online and the destination has enough disk space.</li>
        <li>
          Large managed volumes can compress or extract slowly; byte progress updates once per
          second.
        </li>
        <li>
          Do not start another deploy for the same app; admission remains locked until migration
          completes or fails.
        </li>
      </ul>

      <h2>Remote terminal says “No such container”</h2>
      <p>
        Confirm the deployment&apos;s active node on its Settings page and check Runtime
        applications on Dashboard → Nodes. Upgrade both coordinator and agent if the terminal is
        still attempting Docker exec on the main host; current versions tunnel remote PTY sessions
        through the agent.
      </p>
    </article>
  );
}
