import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <article className="prose max-w-none">
      <h1>Getting Started</h1>
      <p>
        deploy.sh is a self-hosted deployment platform. It runs on your own hardware and gives you a
        simple way to deploy and manage applications without relying on a cloud provider.
      </p>

      <h2>How it works</h2>
      <p>deploy.sh has three components:</p>
      <ol>
        <li>
          <strong>A server</strong> that receives deployments, builds Docker images, manages
          containers, and proxies traffic to your applications.
        </li>
        <li>
          <strong>A CLI tool</strong> that bundles your project and pushes it to the server from any
          directory on your machine.
        </li>
        <li>
          <strong>A web dashboard</strong> (what you&apos;re looking at) that lets you monitor and
          manage your deployments in a browser.
        </li>
      </ol>

      <h2>Prerequisites</h2>
      <p>Before setting up deploy.sh, make sure you have:</p>
      <ul>
        <li>
          <strong>Node.js 22 or later</strong> &mdash; the server and CLI are built with Node.js.
        </li>
        <li>
          <strong>Docker</strong> &mdash; deploy.sh uses Docker to containerize and run your
          applications. Install it from{' '}
          <a href="https://docs.docker.com/get-docker/" target="_blank" rel="noopener noreferrer">
            docker.com
          </a>
          .
        </li>
      </ul>

      <h2>Installation</h2>
      <p>Clone the repository and install dependencies:</p>
      <pre>
        <code>
          git clone https://github.com/gabrielcsapo/deploy.sh.git{'\n'}cd deploy.sh{'\n'}pnpm
          install
        </code>
      </pre>

      <h2>Start the server</h2>
      <p>
        Start the deploy.sh server, which runs the API and web dashboard together in a single
        process:
      </p>
      <pre>
        <code>deploy server</code>
      </pre>
      <p>
        This starts deploy.sh on <code>http://localhost</code> where you can monitor and manage
        your deployments. Use <code>-p</code> to pick a different port.
      </p>

      <h2>Create an account</h2>
      <p>Register a user account so you can authenticate deployments:</p>
      <pre>
        <code>npx deploy register</code>
      </pre>
      <p>
        You&apos;ll be prompted for a username and password. Credentials are stored locally in{' '}
        <code>~/.deployrc</code>.
      </p>

      <h2>Deploy your first app</h2>
      <p>Navigate to any project directory and run:</p>
      <pre>
        <code>npx deploy</code>
      </pre>
      <p>
        deploy.sh will bundle the directory, upload it to the server, auto-detect the project type,
        build a Docker image, and start a container. Once it&apos;s running, you&apos;ll see it in
        the <Link to="/dashboard">dashboard</Link>.
      </p>

      <h2>Next steps</h2>
      <ul>
        <li>
          <Link to="/docs/deploying">Learn about deployment types</Link> &mdash; Node.js, Docker,
          and static sites.
        </li>
        <li>
          <Link to="/docs/cli">CLI reference</Link> &mdash; all available commands and options.
        </li>
        <li>
          <Link to="/docs/architecture">Architecture overview</Link> &mdash; how deploy.sh works
          under the hood.
        </li>
      </ul>
    </article>
  );
}
