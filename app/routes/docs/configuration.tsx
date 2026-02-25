import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Configuration</h1>
      <p>
        By default, deploy.sh requires no configuration file. It auto-detects your project type and
        maps port 3000 inside the container to an available host port. For apps that need custom port
        settings, create a <code>deploy.json</code> file in your project root.
      </p>

      <h2>deploy.json</h2>
      <p>
        Place a <code>deploy.json</code> file in your project root alongside your{' '}
        <code>Dockerfile</code>, <code>package.json</code>, or <code>index.html</code>.
      </p>

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
          <tr>
            <td>
              <code>port</code>
            </td>
            <td>number</td>
            <td>3000</td>
            <td>
              The main port your application listens on inside the container. This is the port that
              gets proxied via the <code>.local</code> URL.
            </td>
          </tr>
          <tr>
            <td>
              <code>ports</code>
            </td>
            <td>array</td>
            <td>[]</td>
            <td>
              Additional ports to expose from the container. Each entry maps a container port to an
              auto-assigned host port.
            </td>
          </tr>
          <tr>
            <td>
              <code>ignore</code>
            </td>
            <td>string[]</td>
            <td>[]</td>
            <td>
              Additional directories or files to exclude from the upload bundle.{' '}
              <code>node_modules</code> and <code>.git</code> are always excluded. In git
              repositories, <code>.gitignore</code> patterns are also respected automatically.
            </td>
          </tr>
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
          <tr>
            <td>
              <code>container</code>
            </td>
            <td>number</td>
            <td>Yes</td>
            <td>The port inside the container (1&ndash;65535).</td>
          </tr>
          <tr>
            <td>
              <code>protocol</code>
            </td>
            <td>string</td>
            <td>No</td>
            <td>
              <code>&quot;tcp&quot;</code> (default) or <code>&quot;udp&quot;</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <h2>Examples</h2>

      <h3>No configuration (default)</h3>
      <p>
        If you don&apos;t create a <code>deploy.json</code>, deploy.sh uses port 3000 as the
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
      <p>
        If your app needs additional ports beyond HTTP, such as an SSH server on port 2222:
      </p>
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
        In git repositories, your <code>.gitignore</code> is respected automatically &mdash; anything
        git ignores is excluded from the upload bundle. To exclude additional paths beyond{' '}
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
        deploy.sh validates <code>deploy.json</code> during upload. If the file contains unknown
        fields, invalid port numbers, or malformed entries, the deploy will fail with a descriptive
        error message.
      </p>
    </article>
  );
}
