import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Deploying Applications</h1>
      <p>
        deploy.local auto-detects your project type based on the files in your project root. No
        configuration file is required&mdash;just run <code>deploy</code> and it figures out the
        rest. If you need to customize port mappings, you can add a{' '}
        <Link to="/docs/configuration">
          <code>deploy.json</code>
        </Link>{' '}
        file to your project root.
      </p>

      <h2>Node.js applications</h2>
      <p>
        <strong>Detected by:</strong> a <code>package.json</code> in the project root.
      </p>
      <p>
        deploy.local generates a Dockerfile using the <code>node:22-alpine</code> base image. It
        installs your dependencies with <code>npm install --production</code> and runs the{' '}
        <code>start</code> script defined in your <code>package.json</code>. If you need a different
        Node.js version, provide your own <code>Dockerfile</code>.
      </p>
      <p>Your app should listen on the port provided by the environment:</p>
      <pre>
        <code>
          {`const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(\`Listening on port \${port}\`);
});`}
        </code>
      </pre>

      <h2>Docker containers</h2>
      <p>
        <strong>Detected by:</strong> a <code>Dockerfile</code> in the project root.
      </p>
      <p>
        If deploy.local finds a Dockerfile, it uses it as-is. This gives you full control over the
        build process, base image, and runtime configuration.
      </p>
      <p>
        Make sure your container exposes a port and listens for HTTP traffic. deploy.local will
        assign a port and proxy requests to your container.
      </p>

      <h2>Static sites</h2>
      <p>
        <strong>Detected by:</strong> an <code>index.html</code> in the project root (without a{' '}
        <code>Dockerfile</code> or <code>package.json</code>).
      </p>
      <p>
        deploy.local serves static files using a lightweight Node.js file server inside a container
        (based on <code>node:22-alpine</code>). It supports common MIME types (HTML, CSS, JS, JSON,
        PNG, JPG, SVG, ICO) and serves <code>index.html</code> for the root path. Requests for
        missing files return a 404 response. Note that SPA (single-page app) client-side routing is
        not built-in&mdash;if you need it, provide your own <code>Dockerfile</code> with a server
        that handles fallback routing.
      </p>

      <h2>Detection priority</h2>
      <p>If your project has multiple marker files, deploy.local uses this priority order:</p>
      <ol>
        <li>
          <code>Dockerfile</code> &mdash; always takes precedence.
        </li>
        <li>
          <code>package.json</code> &mdash; treated as a Node.js app.
        </li>
        <li>
          <code>index.html</code> &mdash; treated as a static site.
        </li>
      </ol>
      <p>
        If none of these files are found, the deployment will fail with an &ldquo;unknown
        type&rdquo; error.
      </p>

      <h2>Persistent storage</h2>
      <p>
        Every deployment automatically gets two persistent volume mounts that survive redeploys:
      </p>
      <ul>
        <li>
          <code>/app/data</code> &mdash; for application data (databases, state files, etc.)
        </li>
        <li>
          <code>/app/uploads</code> &mdash; for user-uploaded files
        </li>
      </ul>
      <p>
        These directories are stored on the host at{' '}
        <code>.deploy-data/volumes/&lt;name&gt;/data</code> and{' '}
        <code>.deploy-data/volumes/&lt;name&gt;/uploads</code>. When you redeploy, the container is
        replaced but the volume data persists. You can also add custom volume mounts from the{' '}
        <Link to="/docs/managing">dashboard</Link>.
      </p>

      <h2>Service discovery</h2>
      <p>
        Each deployment gets its own <code>.local</code> hostname via mDNS (e.g.{' '}
        <code>my-app.local</code>). Deployments can opt in to network discovery by setting the{' '}
        <code>discoverable</code> field to <code>true</code> in{' '}
        <Link to="/docs/configuration">
          <code>deploy.json</code>
        </Link>{' '}
        or toggling it in the dashboard. Discoverable apps appear on the network directory at{' '}
        <code>https://discover.local</code>, which lists all discoverable services on the local
        network.
      </p>

      <h2>Try the examples</h2>
      <p>
        The repo includes an <code>examples/</code> directory with one project per deployment type.
        Use them to test deploy.local without writing any code:
      </p>
      <pre>
        <code>
          {`# Node.js app
cd examples/node && deploy

# Docker container
cd examples/docker && deploy

# Static site
cd examples/static && deploy`}
        </code>
      </pre>

      <h2>What happens during deployment</h2>
      <ol>
        <li>The CLI bundles your project directory into a tarball.</li>
        <li>The tarball is uploaded to the deploy.local server.</li>
        <li>The server extracts the files and classifies the project type.</li>
        <li>A Dockerfile is generated (if one doesn&apos;t exist).</li>
        <li>A Docker image is built from the Dockerfile.</li>
        <li>
          A container is created and started with an assigned port. Persistent volumes (
          <code>/app/data</code>, <code>/app/uploads</code>) are mounted automatically.
        </li>
        <li>
          The deployment appears in the <Link to="/dashboard">dashboard</Link>.
        </li>
      </ol>
    </article>
  );
}
