import { Link } from 'react-flight-router/client';
import { CopyCommand } from '../../components/CopyCommand.client';

export default function Component() {
  return (
    <article className="prose docs-intro-page max-w-none">
      <header className="docs-intro-hero not-prose">
        <div>
          <p className="eyebrow">Orientation</p>
          <h1>Learn the system by following the graph.</h1>
          <p>
            Start at Home, define one complete application, then decide where it should run and
            which durable changes may travel. The same model appears in the CLI, command center, and{' '}
            <code>deploy.yaml</code>.
          </p>
        </div>
        <DocsConceptMap />
      </header>

      <section className="docs-paths not-prose" aria-labelledby="choose-path">
        <div className="docs-section-label">
          <span>Choose a path</span>
          <h2 id="choose-path">What are you trying to do?</h2>
        </div>
        <div className="docs-path-grid">
          <DocPath
            marker="01"
            title="Deploy the first application"
            body="Install Home, register an operator, and turn a local project into a healthy application graph."
            to="#first-deploy"
            label="Start here"
            tone="route"
          />
          <DocPath
            marker="02"
            title="Add machines and services"
            body="Place complete graphs on connected compute and model databases, jobs, routes, and durable resources."
            to="/docs/nodes"
            label="Place the graph"
            tone="ready"
          />
          <DocPath
            marker="03"
            title="Take applications with you"
            body="Pair a Suitcase, admit its data contract, verify offline readiness, and reconcile on return."
            to="/docs/roadmap"
            label="Prepare a Suitcase"
            tone="away"
          />
        </div>
      </section>

      <section id="first-deploy" className="docs-quickstart not-prose">
        <div className="docs-section-label">
          <span>First deployment</span>
          <h2>One authority, one application, one healthy route.</h2>
          <p>
            You need Node.js 26, Docker, and OpenSSL on the Home machine. The installer creates the
            coordinator; the CLI handles the application from there.
          </p>
        </div>
        <ol>
          <QuickStep
            number="01"
            title="Install Home"
            body="Start the coordinator on the machine that should own identity, local TLS, revisions, and recovery history."
          >
            <CopyCommand command="curl -fsSL deploy.local/install | sh" />
          </QuickStep>
          <QuickStep
            number="02"
            title="Create the operator"
            body="Registration stores the administrator credential locally and opens the command center."
          >
            <pre>
              <code>deploy register</code>
            </pre>
          </QuickStep>
          <QuickStep
            number="03"
            title="Deploy from a project"
            body="Run the CLI inside a Node.js, Docker, or static project. A manifest stays optional until the graph needs more structure."
          >
            <pre>
              <code>deploy</code>
            </pre>
          </QuickStep>
        </ol>
        <div className="docs-expected-result">
          <span>Expected result</span>
          <strong>https://your-app.local</strong>
          <p>The route becomes public only after the selected runtime reports healthy.</p>
        </div>
      </section>

      <section className="docs-vocabulary not-prose">
        <div className="docs-section-label">
          <span>Graph vocabulary</span>
          <h2>Four boundaries explain most of the product.</h2>
        </div>
        <div className="docs-vocabulary-grid">
          <Vocabulary
            letter="H"
            title="Home"
            body="The authority for operators, releases, addresses, and durable history."
          />
          <Vocabulary
            letter="A"
            title="Application"
            body="The complete graph of routes, components, jobs, resources, and configuration."
          />
          <Vocabulary
            letter="P"
            title="Place"
            body="A machine supplies compute; a site supplies an operating and data boundary."
          />
          <Vocabulary
            letter="D"
            title="Data contract"
            body="The declared rules that decide whether durable changes stay local, move, or reconcile."
          />
        </div>
      </section>

      <section className="docs-next not-prose">
        <div className="docs-section-label">
          <span>Continue through the graph</span>
          <h2>Go deeper without losing context.</h2>
        </div>
        <div className="docs-next-list">
          <NextRoute
            to="/docs/configuration"
            name="Define the application graph"
            detail="deploy.yaml, components, services, data, routes, jobs, and typed configuration"
          />
          <NextRoute
            to="/docs/deploying"
            name="Build and deploy"
            detail="Auto-detection, Dockerfiles, static sites, revisions, and health gates"
          />
          <NextRoute
            to="/docs/nodes"
            name="Place the graph"
            detail="Connected machines, placement choices, remote builds, and local routing"
          />
          <NextRoute
            to="/docs/roadmap"
            name="Carry and reconcile"
            detail="Suitcase readiness, sync modes, data compatibility, and return workflows"
          />
          <NextRoute
            to="/docs/architecture"
            name="Understand the system"
            detail="Desired, active, and actual state across coordinators, nodes, and sites"
          />
        </div>
      </section>
    </article>
  );
}

function DocsConceptMap() {
  return (
    <div className="docs-concept-map" aria-label="Home routes an application graph to places">
      <span className="concept-home">Home</span>
      <span className="concept-route">request</span>
      <span className="concept-app">application graph</span>
      <span className="concept-place">machine</span>
      <span className="concept-suitcase">suitcase</span>
      <i className="concept-line line-one" aria-hidden="true" />
      <i className="concept-line line-two" aria-hidden="true" />
      <i className="concept-line line-three" aria-hidden="true" />
    </div>
  );
}

function DocPath({
  marker,
  title,
  body,
  to,
  label,
  tone,
}: {
  marker: string;
  title: string;
  body: string;
  to: string;
  label: string;
  tone: 'route' | 'ready' | 'away';
}) {
  return (
    <Link to={to} className={`docs-path tone-${tone}`}>
      <span>{marker}</span>
      <h3>{title}</h3>
      <p>{body}</p>
      <strong>
        {label} <i aria-hidden="true">→</i>
      </strong>
    </Link>
  );
}

function QuickStep({
  number,
  title,
  body,
  children,
}: {
  number: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <li>
      <span>{number}</span>
      <div>
        <h3>{title}</h3>
        <p>{body}</p>
        {children}
      </div>
    </li>
  );
}

function Vocabulary({ letter, title, body }: { letter: string; title: string; body: string }) {
  return (
    <article>
      <span>{letter}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function NextRoute({ to, name, detail }: { to: string; name: string; detail: string }) {
  return (
    <Link to={to}>
      <span>
        <strong>{name}</strong>
        <small>{detail}</small>
      </span>
      <i aria-hidden="true">→</i>
    </Link>
  );
}
