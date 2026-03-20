import { Link } from 'react-flight-router/client';

export default function Component() {
  return (
    <main className="max-w-7xl mx-auto px-6">
      <section className="py-20 max-w-2xl">
        <p className="text-sm font-medium text-accent mb-4">Self-hosted deployment platform</p>
        <h1 className="text-4xl font-bold tracking-tight leading-tight mb-5">
          Deploy from your own server.
          <br />
          <span className="text-text-secondary">No cloud provider needed.</span>
        </h1>
        <p className="text-text-secondary leading-relaxed mb-8">
          deploy.sh turns any machine into a deployment platform. Push your code, and it handles
          building, containerization, and routing. Node.js apps, Docker containers, static
          sites&mdash;all managed through a single dashboard.
        </p>
        <div className="flex gap-3">
          <Link to="/docs" className="btn btn-primary">
            Read the docs
          </Link>
          <Link to="/dashboard" className="btn">
            Open dashboard
          </Link>
        </div>
      </section>

      <section className="border-t border-border py-16">
        <h2 className="text-lg font-semibold mb-4">Install the CLI</h2>
        <div className="rounded-xl border border-border bg-bg-surface overflow-hidden max-w-2xl">
          <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
            <div className="w-2.5 h-2.5 rounded-full bg-text-tertiary/30" />
            <div className="w-2.5 h-2.5 rounded-full bg-text-tertiary/30" />
            <div className="w-2.5 h-2.5 rounded-full bg-text-tertiary/30" />
            <span className="text-xs text-text-tertiary ml-2 font-mono">terminal</span>
          </div>
          <pre className="p-4 text-sm font-mono leading-relaxed text-text-secondary overflow-x-auto">
            <code>
              <span className="text-text-tertiary"># Install the deploy CLI from this server</span>
              {'\n'}
              <span className="text-text-tertiary">$</span>{' '}
              <span className="text-text">curl -fsSL</span>{' '}
              <span className="text-accent">http://deploy.local/install</span>{' '}
              <span className="text-text">| sh</span>
              {'\n'}
              {'\n'}
              <span className="text-text-tertiary"># Register an account</span>
              {'\n'}
              <span className="text-text-tertiary">$</span>{' '}
              <span className="text-text">deploy register</span>
              {'\n'}
              {'\n'}
              <span className="text-text-tertiary"># Deploy a project</span>
              {'\n'}
              <span className="text-text-tertiary">$</span> <span className="text-text">cd</span>{' '}
              my-project{'\n'}
              <span className="text-text-tertiary">$</span>{' '}
              <span className="text-text">deploy</span>
              {'\n'}
              <span className="text-success">&#10003;</span>{' '}
              <span className="text-text-tertiary">Deployed to https://my-project.local</span>
            </code>
          </pre>
        </div>
      </section>

      <section className="border-t border-border py-16">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-border rounded-xl overflow-hidden border border-border">
          <div className="bg-bg-surface p-6">
            <div className="text-xs font-mono text-accent mb-3">01</div>
            <h3 className="text-sm font-semibold mb-2">Push your code</h3>
            <p className="text-sm text-text-secondary leading-relaxed">
              Bundle your project and upload it. deploy.sh auto-detects whether it&apos;s a Node.js
              app, Docker container, or static site.
            </p>
          </div>
          <div className="bg-bg-surface p-6">
            <div className="text-xs font-mono text-accent mb-3">02</div>
            <h3 className="text-sm font-semibold mb-2">Automatic builds</h3>
            <p className="text-sm text-text-secondary leading-relaxed">
              A Dockerfile is generated if needed, the image is built, and a container is started
              with an allocated port.
            </p>
          </div>
          <div className="bg-bg-surface p-6">
            <div className="text-xs font-mono text-accent mb-3">03</div>
            <h3 className="text-sm font-semibold mb-2">Manage everything</h3>
            <p className="text-sm text-text-secondary leading-relaxed">
              View logs, monitor status, scale, or tear down deployments from the dashboard or CLI.
              Your server, your rules.
            </p>
          </div>
        </div>
      </section>

      <section className="border-t border-border py-16">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-12">
          <div>
            <h2 className="text-lg font-semibold mb-4">Why self-host?</h2>
            <ul className="space-y-3">
              <li className="flex gap-3 text-sm text-text-secondary">
                <span className="text-accent shrink-0 mt-0.5">&#10003;</span>
                <span>
                  <strong className="text-text">No vendor lock-in.</strong> Run on any Linux
                  machine, old laptop, Raspberry Pi, or rack server.
                </span>
              </li>
              <li className="flex gap-3 text-sm text-text-secondary">
                <span className="text-accent shrink-0 mt-0.5">&#10003;</span>
                <span>
                  <strong className="text-text">No monthly bills.</strong> Use hardware you already
                  own. No per-seat pricing, no compute charges.
                </span>
              </li>
              <li className="flex gap-3 text-sm text-text-secondary">
                <span className="text-accent shrink-0 mt-0.5">&#10003;</span>
                <span>
                  <strong className="text-text">Full control.</strong> Your data stays on your
                  machine. Inspect and modify the platform itself.
                </span>
              </li>
              <li className="flex gap-3 text-sm text-text-secondary">
                <span className="text-accent shrink-0 mt-0.5">&#10003;</span>
                <span>
                  <strong className="text-text">Open source.</strong> MIT licensed. Read the code,
                  contribute, fork it.
                </span>
              </li>
            </ul>
          </div>
          <div>
            <h2 className="text-lg font-semibold mb-4">Set up the server</h2>
            <div className="rounded-xl border border-border bg-bg-surface overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
                <div className="w-2.5 h-2.5 rounded-full bg-text-tertiary/30" />
                <div className="w-2.5 h-2.5 rounded-full bg-text-tertiary/30" />
                <div className="w-2.5 h-2.5 rounded-full bg-text-tertiary/30" />
                <span className="text-xs text-text-tertiary ml-2 font-mono">terminal</span>
              </div>
              <pre className="p-4 text-sm font-mono leading-relaxed text-text-secondary overflow-x-auto">
                <code>
                  <span className="text-text-tertiary">$</span>{' '}
                  <span className="text-text">git clone</span>{' '}
                  <span className="text-accent">https://github.com/gabrielcsapo/deploy.sh.git</span>
                  {'\n'}
                  <span className="text-text-tertiary">$</span>{' '}
                  <span className="text-text">cd</span> deploy.sh{'\n'}
                  <span className="text-text-tertiary">$</span>{' '}
                  <span className="text-text">pnpm install</span>{' '}
                  <span className="text-text-tertiary">&amp;&amp;</span>{' '}
                  <span className="text-text">pnpm build</span>
                  {'\n'}
                  <span className="text-text-tertiary">$</span>{' '}
                  <span className="text-text">pnpm start</span>
                  {'\n'}
                  <span className="text-success">&#10003;</span>{' '}
                  <span className="text-text-tertiary">
                    deploy.sh running on https://deploy.local
                  </span>
                </code>
              </pre>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
