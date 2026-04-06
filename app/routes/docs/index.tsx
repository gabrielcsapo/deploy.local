import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Getting Started</h1>
      <p>
        deploy.local is a self-hosted deployment platform. It runs on your own hardware and gives
        you a simple way to deploy and manage applications without relying on a cloud provider.
      </p>

      <h2>How it works</h2>
      <p>deploy.local has three components:</p>
      <ol>
        <li>
          <strong>A server</strong> that receives deployments, builds Docker images, manages
          containers, and proxies traffic to your applications over HTTPS.
        </li>
        <li>
          <strong>A CLI tool</strong> that bundles your project and pushes it to the server from any
          machine on your network.
        </li>
        <li>
          <strong>A web dashboard</strong> (what you&apos;re looking at) that lets you monitor and
          manage your deployments in a browser.
        </li>
      </ol>

      <h2>Prerequisites</h2>
      <p>Before setting up deploy.local, make sure the server machine has:</p>
      <ul>
        <li>
          <strong>Node.js 22 or later</strong> &mdash; the server and CLI are built with Node.js.
        </li>
        <li>
          <strong>Docker</strong> &mdash; deploy.local uses Docker to containerize and run your
          applications. Install it from{' '}
          <a href="https://docs.docker.com/get-docker/" target="_blank" rel="noopener noreferrer">
            docker.com
          </a>
          .
        </li>
        <li>
          <strong>OpenSSL</strong> &mdash; used to generate TLS certificates on first startup.
        </li>
      </ul>

      <h2>Server setup</h2>
      <p>Clone the repository, install dependencies, and build:</p>
      <pre>
        <code>
          {`git clone https://github.com/gabrielcsapo/deploy.local.git
cd deploy.local
pnpm install && pnpm build`}
        </code>
      </pre>
      <p>Start the server:</p>
      <pre>
        <code>pnpm start</code>
      </pre>
      <p>
        This starts deploy.local on <code>https://deploy.local</code> (HTTPS on port 443, with an
        HTTP redirect on port 80). On first startup, a local CA certificate and server certificate
        are generated automatically.
      </p>

      <h2>Trust the CA certificate</h2>
      <p>
        To access the dashboard and deployed apps without TLS warnings, you need to trust the
        deploy.local CA certificate on each machine that will access the server:
      </p>
      <pre>
        <code>curl -O http://deploy.local/ca.crt</code>
      </pre>
      <ul>
        <li>
          <strong>macOS:</strong> Open the downloaded file to add it to Keychain Access, then
          double-click the certificate in Keychain and set Trust to &ldquo;Always Trust.&rdquo;
        </li>
        <li>
          <strong>Linux:</strong> Copy to <code>/usr/local/share/ca-certificates/</code> and run{' '}
          <code>sudo update-ca-certificates</code>.
        </li>
      </ul>

      <h2>Install the CLI</h2>
      <p>
        <strong>On the server machine:</strong> The CLI is already available after{' '}
        <code>pnpm install</code>.
      </p>
      <p>
        <strong>On other machines:</strong> Install the CLI from the server:
      </p>
      <pre>
        <code>curl -fsSL http://deploy.local/install | sh</code>
      </pre>
      <p>
        This downloads a pre-built binary for your platform (macOS or Linux, x64 or arm64) and
        configures <code>~/.deployrc</code> with the server URL. Supported platforms: darwin-x64,
        darwin-arm64, linux-x64, linux-arm64.
      </p>

      <h2>Create an account</h2>
      <p>Register a user account so you can authenticate deployments:</p>
      <pre>
        <code>deploy register</code>
      </pre>
      <p>
        You&apos;ll be prompted for a username and password. Credentials are stored locally in{' '}
        <code>~/.deployrc</code>.
      </p>

      <h2>Deploy your first app</h2>
      <p>Navigate to any project directory and run:</p>
      <pre>
        <code>deploy</code>
      </pre>
      <p>
        deploy.local will bundle the directory, upload it to the server, auto-detect the project
        type, build a Docker image, and start a container. Once it&apos;s running, you&apos;ll see
        it in the <Link to="/dashboard">dashboard</Link> and it will be accessible at{' '}
        <code>https://&lt;name&gt;.local</code>.
      </p>

      <h2>Next steps</h2>
      <ul>
        <li>
          <Link to="/docs/deploying">Learn about deployment types</Link> &mdash; Node.js, Docker,
          and static sites.
        </li>
        <li>
          <Link to="/docs/managing">Managing deployments</Link> &mdash; environment variables,
          backups, terminal, and more.
        </li>
        <li>
          <Link to="/docs/cli">CLI reference</Link> &mdash; all available commands and options.
        </li>
        <li>
          <Link to="/docs/architecture">Architecture overview</Link> &mdash; how deploy.local works
          under the hood.
        </li>
        <li>
          <Link to="/docs/troubleshooting">Troubleshooting</Link> &mdash; solutions to common
          issues.
        </li>
      </ul>
    </article>
  );
}
