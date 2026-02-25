import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Deploying Applications</h1>
      <p>
        deploy.sh auto-detects your project type based on the files in your project root. No
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
        deploy.sh generates a Dockerfile using a Node.js Alpine base image. It installs your
        dependencies with <code>npm install</code> and runs the <code>start</code> script defined in
        your <code>package.json</code>.
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
        If deploy.sh finds a Dockerfile, it uses it as-is. This gives you full control over the
        build process, base image, and runtime configuration.
      </p>
      <p>
        Make sure your container exposes a port and listens for HTTP traffic. deploy.sh will assign
        a port and proxy requests to your container.
      </p>

      <h2>Static sites</h2>
      <p>
        <strong>Detected by:</strong> an <code>index.html</code> in the project root (without a{' '}
        <code>Dockerfile</code> or <code>package.json</code>).
      </p>
      <p>
        deploy.sh serves static files using a lightweight Node.js file server inside a container.
        Drop in your HTML, CSS, and JavaScript files and deploy.
      </p>

      <h2>Detection priority</h2>
      <p>If your project has multiple marker files, deploy.sh uses this priority order:</p>
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

      <h2>Try the examples</h2>
      <p>
        The repo includes an <code>examples/</code> directory with one project per deployment type.
        Use them to test deploy.sh without writing any code:
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
        <li>The tarball is uploaded to the deploy.sh server.</li>
        <li>The server extracts the files and classifies the project type.</li>
        <li>A Dockerfile is generated (if one doesn&apos;t exist).</li>
        <li>A Docker image is built from the Dockerfile.</li>
        <li>A container is created and started with an assigned port.</li>
        <li>
          The deployment appears in the <Link to="/dashboard">dashboard</Link>.
        </li>
      </ol>
    </article>
  );
}
