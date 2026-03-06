export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Architecture</h1>
      <p>
        deploy.sh is designed to be simple. It has a small surface area and few moving parts, so you
        can understand and modify it easily.
      </p>

      <h2>System overview</h2>
      <pre>
        <code>
          {`┌─────────────┐     HTTP      ┌──────────────────┐     Docker CLI      ┌────────────┐
│   CLI / UI  │ ──────────▶  │  deploy.sh server │ ──────────────▶  │  Containers │
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
        The server is a Node.js HTTP server that runs on port 80 by default. It handles user
        authentication, receives deployment uploads, builds Docker images, manages containers, and
        collects resource metrics.
      </p>
      <p>
        Each deployed application gets its own port. The server tracks which container is assigned
        to which port so you can access your apps directly.
      </p>

      <h2>Authentication</h2>
      <p>
        deploy.sh uses a simple token-based authentication system. When you register or log in, the
        server generates a token that is stored both server-side (in SQLite) and client-side (in{' '}
        <code>~/.deployrc</code>). Every API request includes the username and token in HTTP
        headers.
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
          port, and started.
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
          <strong>users</strong> &mdash; username, hashed password (SHA-256), and auth token.
        </li>
        <li>
          <strong>deployments</strong> &mdash; container ID, name, port, extra port mappings, type,
          directory path, owner username, and timestamps.
        </li>
        <li>
          <strong>history</strong> &mdash; audit trail of deploy, restart, and delete events per
          application.
        </li>
        <li>
          <strong>request_logs</strong> &mdash; HTTP request log per deployment (all data preserved
          indefinitely).
        </li>
        <li>
          <strong>resource_metrics</strong> &mdash; CPU, memory, network, and disk I/O samples per
          container (all data preserved indefinitely).
        </li>
      </ul>
      <p>
        Uploaded project files are stored in <code>.deploy-data/uploads/</code>.
      </p>

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
            <td>Node.js HTTP</td>
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
        </tbody>
      </table>
    </article>
  );
}
