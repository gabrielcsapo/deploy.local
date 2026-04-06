export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Architecture</h1>
      <p>
        deploy.local is designed to be simple. It has a small surface area and few moving parts, so
        you can understand and modify it easily.
      </p>

      <h2>System overview</h2>
      <pre>
        <code>
          {`┌─────────────┐    HTTPS     ┌──────────────────┐     Docker CLI      ┌────────────┐
│   CLI / UI  │ ──────────▶  │  deploy.local server │ ──────────────▶  │  Containers │
└─────────────┘              └──────────────────┘                   └────────────┘
                                      │
                                      │  SQLite
                                      ▼
                               ┌────────────┐
                               │  deploy.db  │
                               └────────────┘`}
        </code>
      </pre>

      <h2>Server</h2>
      <p>
        The server is a Node.js HTTPS server that runs on port 443 by default (falling back to 8443
        if 443 is unavailable). It handles user authentication, receives deployment uploads, builds
        Docker images, manages containers, and collects resource metrics. A separate HTTP server on
        port 80 redirects browsers to HTTPS and serves the CA certificate and CLI install script.
      </p>
      <p>
        Each deployed application gets its own <code>.local</code> hostname via mDNS. The server
        tracks which container is assigned to which port so it can proxy requests to the right
        container.
      </p>

      <h2>HTTPS and certificates</h2>
      <p>
        deploy.local uses HTTPS for all traffic. On first startup, it generates a local Certificate
        Authority (CA) and a server certificate using <code>openssl</code> (which must be installed
        on the server machine). The server certificate includes SAN entries for every deployment
        hostname (e.g. <code>my-app.local</code>) and is automatically regenerated when new
        deployments are created.
      </p>
      <p>
        To avoid browser TLS warnings, you need to trust the CA certificate on each client machine:
      </p>
      <ol>
        <li>
          Download the CA cert: <code>curl -O http://deploy.local/ca.crt</code>
        </li>
        <li>
          <strong>macOS:</strong> Open the file to add it to Keychain Access, then set it to
          &ldquo;Always Trust&rdquo; in the certificate&apos;s Trust settings.
        </li>
        <li>
          <strong>Linux:</strong> Copy to <code>/usr/local/share/ca-certificates/</code> and run{' '}
          <code>sudo update-ca-certificates</code>.
        </li>
      </ol>
      <p>
        The CA and server certificates are stored in <code>.deploy-data/certs/</code>. The TLS
        context is hot-reloaded when certificates change, so existing connections are not disrupted.
      </p>

      <h2>Authentication</h2>
      <p>
        deploy.local uses session-based token authentication. When you register or log in, the
        server generates a token that is stored in the <code>sessions</code> table (server-side) and
        in <code>~/.deployrc</code> (client-side). Every API request includes the username and token
        in HTTP headers.
      </p>

      <h2>Deployment pipeline</h2>
      <p>
        When you run <code>deploy</code> from a project directory:
      </p>
      <ol>
        <li>
          <strong>Bundle</strong> &mdash; The CLI creates a <code>.tar.gz</code> archive of the
          project directory.
        </li>
        <li>
          <strong>Upload</strong> &mdash; The archive is uploaded to the server via a multipart form
          POST to <code>/api/upload</code>.
        </li>
        <li>
          <strong>Extract</strong> &mdash; The server extracts the archive into a per-deployment
          directory.
        </li>
        <li>
          <strong>Classify</strong> &mdash; The server inspects the extracted files to determine the
          project type (Docker, Node.js, or static).
        </li>
        <li>
          <strong>Configure</strong> &mdash; If a <code>deploy.json</code> exists, port
          configuration is read from it (custom app port, extra ports).
        </li>
        <li>
          <strong>Build</strong> &mdash; A Dockerfile is generated (if needed), and a Docker image
          is built.
        </li>
        <li>
          <strong>Run</strong> &mdash; A container is created from the image, assigned an available
          port, and started. Persistent volumes are mounted at <code>/app/data</code> and{' '}
          <code>/app/uploads</code>.
        </li>
        <li>
          <strong>Store</strong> &mdash; The deployment metadata (container ID, port, name) is saved
          to the database.
        </li>
      </ol>

      <h2>Request routing</h2>
      <p>
        The server includes a catch-all route that proxies incoming requests to the appropriate
        container. When a request comes in, the server looks up the deployment by subdomain or name,
        finds the assigned port, and forwards the request to the container. Each proxied request is
        logged with its method, path, status code, and response time.
      </p>

      <h2>Data storage</h2>
      <p>
        All data is stored in a SQLite database at <code>.deploy-data/deploy.db</code> using Drizzle
        ORM with better-sqlite3. No external database server is needed. The database contains these
        tables:
      </p>
      <ul>
        <li>
          <strong>users</strong> &mdash; username and hashed password.
        </li>
        <li>
          <strong>sessions</strong> &mdash; auth tokens with username association and creation
          timestamps.
        </li>
        <li>
          <strong>deployments</strong> &mdash; container ID, name, port, extra port mappings, type,
          directory path, environment variables, memory limits, volumes, GPU settings, owner
          username, and timestamps.
        </li>
        <li>
          <strong>history</strong> &mdash; audit trail of deploy, restart, and delete events per
          application.
        </li>
        <li>
          <strong>request_logs</strong> &mdash; HTTP request log per deployment (pruned after 90
          days).
        </li>
        <li>
          <strong>resource_metrics</strong> &mdash; CPU, memory, network, and disk I/O samples per
          container (pruned after 30 days).
        </li>
        <li>
          <strong>build_logs</strong> &mdash; build output, status, and duration for each
          deployment.
        </li>
        <li>
          <strong>backups</strong> &mdash; metadata for volume backups (filename, size, label).
        </li>
        <li>
          <strong>system_settings</strong> &mdash; server-wide configuration (e.g. rsync backup
          settings).
        </li>
      </ul>
      <p>
        Uploaded project files are stored in <code>.deploy-data/uploads/</code>. Persistent volume
        data is stored in <code>.deploy-data/volumes/</code>.
      </p>

      <h2>Data retention</h2>
      <p>A maintenance cycle runs every 6 hours that prunes old data and runs a database VACUUM:</p>
      <ul>
        <li>
          <strong>Resource metrics</strong> &mdash; pruned after 30 days.
        </li>
        <li>
          <strong>Request logs</strong> &mdash; pruned after 90 days.
        </li>
      </ul>
      <p>All other data (deployments, history, build logs, backups) is preserved indefinitely.</p>

      <h2>Environment variables</h2>
      <p>The server respects these environment variables:</p>
      <table>
        <thead>
          <tr>
            <th>Variable</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>
              <code>DEPLOY_DATA_DIR</code>
            </td>
            <td>
              <code>.deploy-data</code>
            </td>
            <td>Directory for the database, certs, uploads, and volumes.</td>
          </tr>
          <tr>
            <td>
              <code>HTTPS_PORT</code>
            </td>
            <td>
              <code>443</code>
            </td>
            <td>HTTPS server port (falls back to 8443 if unavailable).</td>
          </tr>
          <tr>
            <td>
              <code>PORT</code>
            </td>
            <td>
              <code>80</code>
            </td>
            <td>HTTP server port (redirects to HTTPS, serves CA cert and install script).</td>
          </tr>
        </tbody>
      </table>

      <h2>Technology stack</h2>
      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th>Technology</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Server</td>
            <td>Node.js HTTPS + HTTP (redirect)</td>
          </tr>
          <tr>
            <td>Database</td>
            <td>
              SQLite via better-sqlite3 + Drizzle ORM (<code>.deploy-data/deploy.db</code>)
            </td>
          </tr>
          <tr>
            <td>Containers</td>
            <td>Docker CLI</td>
          </tr>
          <tr>
            <td>CLI</td>
            <td>
              Node.js built-ins (<code>node:util</code> parseArgs)
            </td>
          </tr>
          <tr>
            <td>Dashboard</td>
            <td>React 19 RSC + react-flight-router + Vite + Tailwind CSS</td>
          </tr>
          <tr>
            <td>TLS</td>
            <td>Auto-generated CA + server certs via OpenSSL</td>
          </tr>
          <tr>
            <td>Service Discovery</td>
            <td>
              mDNS (multicast DNS) for <code>.local</code> hostnames
            </td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}
