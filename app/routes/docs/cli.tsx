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

      <h2>deploy files</h2>
      <p>
        List all files that would be bundled for deployment. Useful for verifying your{' '}
        <code>.gitignore</code> and <code>deploy.json</code> ignore patterns before deploying.
        Alias: <code>f</code>
      </p>
      <pre>
        <code>deploy files</code>
      </pre>

      <h2>deploy schema</h2>
      <p>
        Copy the <code>deploy.schema.json</code> file to the current directory. This enables editor
        autocompletion and validation for your <code>deploy.json</code> configuration.
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
              <code>start</code>
            </td>
            <td>server</td>
          </tr>
        </tbody>
      </table>
    </article>
  );
}
