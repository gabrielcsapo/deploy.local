import { Link } from 'react-flight-router/client';
import schema from '../../../deploy.schema.json';

function formatType(prop: Record<string, unknown>): string {
  if (prop.type === 'array') {
    const items = prop.items as Record<string, unknown> | undefined;
    if (items?.type === 'string') return 'string[]';
    if (items?.type === 'object') return 'array';
    return 'array';
  }
  if (prop.type === 'integer') return 'number';
  return prop.type as string;
}

function formatDefault(prop: Record<string, unknown>): string {
  if (prop.default === undefined) return '—';
  if (typeof prop.default === 'boolean') return String(prop.default);
  if (Array.isArray(prop.default)) return '[]';
  return String(prop.default);
}

const TOP_LEVEL_FIELDS = Object.entries(schema.properties).filter(([key]) => key !== '$schema');

const portsItemProps = schema.properties.ports.items as {
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
};

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Configuration</h1>
      <p>
        By default, deploy.local requires no configuration file. It auto-detects your project type
        and maps port 3000 inside the container to an available host port. For apps that need custom
        port settings, create a <code>deploy.json</code> file in your project root.
      </p>

      <h2>deploy.json</h2>
      <p>
        Place a <code>deploy.json</code> file in your project root alongside your{' '}
        <code>Dockerfile</code>, <code>package.json</code>, or <code>index.html</code>.
      </p>

      <h3>JSON Schema</h3>
      <p>
        A JSON schema is available for editor autocompletion and validation. First, copy the schema
        into your project:
      </p>
      <pre>
        <code>deploy schema</code>
      </pre>
      <p>
        Then add a <code>$schema</code> field to your <code>deploy.json</code>:
      </p>
      <pre>
        <code>
          {`{
  "$schema": "./deploy.schema.json",
  "port": 3000
}`}
        </code>
      </pre>

      <h3>Fields</h3>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Default</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {TOP_LEVEL_FIELDS.map(([key, prop]) => (
            <tr key={key}>
              <td>
                <code>{key}</code>
              </td>
              <td>{formatType(prop as Record<string, unknown>)}</td>
              <td>{formatDefault(prop as Record<string, unknown>)}</td>
              <td>{(prop as Record<string, unknown>).description as string}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        Each entry in <code>ports</code> is an object with:
      </p>
      <table>
        <thead>
          <tr>
            <th>Field</th>
            <th>Type</th>
            <th>Required</th>
            <th>Description</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(portsItemProps.properties).map(([key, prop]) => (
            <tr key={key}>
              <td>
                <code>{key}</code>
              </td>
              <td>{formatType(prop)}</td>
              <td>{portsItemProps.required?.includes(key) ? 'Yes' : 'No'}</td>
              <td>
                {prop.description as string}
                {prop.enum ? (
                  <>
                    {' '}
                    (
                    {(prop.enum as string[]).map((v, i) => (
                      <span key={v}>
                        {i > 0 && ' or '}
                        <code>"{v}"</code>
                      </span>
                    ))}
                    )
                  </>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Examples</h2>

      <h3>No configuration (default)</h3>
      <p>
        If you don&apos;t create a <code>deploy.json</code>, deploy.local uses port 3000 as the
        container port with no extra ports. This is the zero-config happy path.
      </p>

      <h3>Custom app port</h3>
      <p>If your app listens on a different port (e.g. 8080):</p>
      <pre>
        <code>
          {`{
  "port": 8080
}`}
        </code>
      </pre>

      <h3>Extra ports (e.g. SSH)</h3>
      <p>If your app needs additional ports beyond HTTP, such as an SSH server on port 2222:</p>
      <pre>
        <code>
          {`{
  "port": 3000,
  "ports": [
    { "container": 2222 }
  ]
}`}
        </code>
      </pre>
      <p>
        The extra port is assigned an available host port automatically. You can see the assigned
        ports in the <Link to="/dashboard">dashboard</Link> under each deployment&apos;s overview.
      </p>

      <h3>Ignoring files and directories</h3>
      <p>
        In git repositories, your <code>.gitignore</code> is respected automatically &mdash;
        anything git ignores is excluded from the upload bundle. To exclude additional paths beyond{' '}
        <code>.gitignore</code>, use the <code>ignore</code> field:
      </p>
      <pre>
        <code>
          {`{
  "ignore": ["test", "docs", ".vscode"]
}`}
        </code>
      </pre>
      <p>
        For non-git projects, <code>node_modules</code> and <code>.git</code> are always excluded,
        and the <code>ignore</code> entries are applied on top.
      </p>

      <h3>Edge response caching</h3>
      <p>
        Response caching is opt-in and intended for public, read-only content. A matching response
        is cached only when it is a successful <code>GET</code> or <code>HEAD</code>, has an
        explicit public <code>Cache-Control</code> policy, and does not set cookies. Requests with
        cookies or authorization headers, streaming responses, private responses, and
        <code>no-store</code> responses always bypass the cache.
      </p>

      <pre>
        <code>
          {`{
  "cache": {
    "enabled": true,
    "maxAge": 60,
    "paths": ["/assets/*", "/api/public/*"],
    "maxObjectBytes": 2097152
  }
}`}
        </code>
      </pre>
      <p>
        A trailing <code>*</code> performs prefix matching. Cache keys include the deployment port,
        so every blue/green switchover immediately uses a fresh namespace. Responses include
        <code>X-Deploy-Cache: HIT</code> or <code>MISS</code> for troubleshooting.
      </p>

      <h3>Docker networks and runtime arguments</h3>
      <p>
        The optional <code>docker</code> section configures Docker-specific runtime behavior.
        Networks are inspected and created only when missing, then attached to every newly deployed
        or recreated container. The first network is used as the primary <code>docker run</code>
        network; additional networks are connected immediately after container creation.
      </p>
      <pre>
        <code>
          {`{
  "docker": {
    "networks": [
      {
        "name": "groffee-ci",
        "subnet": "172.30.0.0/24",
        "labels": {
          "com.groffee.egress": "restricted"
        }
      }
    ],
    "runArgs": ["--dns", "172.30.0.10"]
  }
}`}
        </code>
      </pre>
      <p>
        This is equivalent to creating <code>groffee-ci</code> with the configured subnet and label,
        then starting the app with <code>--network groffee-ci</code>. Values in
        <code>runArgs</code> are passed directly as argument boundaries without shell evaluation.
        Container lifecycle arguments such as <code>--name</code>, <code>--rm</code>, and detached
        mode are reserved so deploy.local can continue to manage blue/green rollouts safely.
      </p>
      <h3>Multiple extra ports</h3>
      <pre>
        <code>
          {`{
  "port": 3000,
  "ports": [
    { "container": 2222 },
    { "container": 5432, "protocol": "tcp" }
  ]
}`}
        </code>
      </pre>

      <h2>Validation</h2>
      <p>
        deploy.local validates <code>deploy.json</code> during upload. If the file contains unknown
        fields, invalid port numbers, or malformed entries, the deploy will fail with a descriptive
        error message.
      </p>
    </article>
  );
}
