import { Link } from 'react-flight-router/client';
import { AuthAwareCTA } from '../components/AuthAwareCTA.client';
import { CopyCommand } from '../components/CopyCommand.client';
import { LandingApplicationCanvas } from './LandingApplicationCanvas.client';

export default function Component() {
  return (
    <main className="welcome-home">
      <section className="welcome-hero">
        <div className="welcome-glow" aria-hidden />
        <div className="welcome-hero-copy">
          <p className="welcome-kicker">
            <span /> Your personal application cloud
          </p>
          <h1>
            Deploy at home.
            <br />
            <em>Feel at ease.</em>
          </h1>
          <p className="welcome-lede">
            One calm place to run your applications across the machines you already own. Start
            simple, then add services, data, and new places when you need them.
          </p>
          <div className="welcome-actions">
            <AuthAwareCTA />
            <Link to="/docs" className="welcome-secondary-action">
              Read the docs
            </Link>
          </div>
        </div>
        <LandingApplicationCanvas />
      </section>

      <section className="welcome-principles" aria-labelledby="welcome-principles-title">
        <div className="welcome-section-copy">
          <p className="welcome-kicker">Everything in context</p>
          <h2 id="welcome-principles-title">Your application is the interface.</h2>
          <p>
            No infrastructure maze. Open an application and see the services, data, health, and
            connections that belong to it.
          </p>
        </div>
        <div className="welcome-principle-grid">
          <WelcomePrinciple
            number="01"
            title="Deploy naturally"
            body="Start from a repository, container, or catalog. deploy.local turns it into a clear application graph."
          />
          <WelcomePrinciple
            number="02"
            title="Grow in place"
            body="Add a worker, database, route, or another machine without leaving the application canvas."
          />
          <WelcomePrinciple
            number="03"
            title="Stay yours"
            body="Your machines run the work. Home coordinates it, and your applications remain understandable."
          />
        </div>
      </section>

      <section className="welcome-start">
        <div>
          <p className="welcome-kicker">Start with one machine</p>
          <h2>A small cloud can still feel beautifully simple.</h2>
          <p>
            Install Home, open the command center, and deploy your first application. Everything
            else can wait until it earns a place.
          </p>
          <div className="welcome-actions">
            <AuthAwareCTA />
            <a
              href="https://github.com/gabrielcsapo/deploy.local"
              target="_blank"
              rel="noopener noreferrer"
              className="welcome-secondary-action"
            >
              View source
            </a>
          </div>
        </div>
        <div className="welcome-install">
          <span>Install deploy.local</span>
          <CopyCommand command="curl -fsSL deploy.local/install | sh" />
          <small>macOS · Linux · Windows with Docker</small>
        </div>
      </section>
    </main>
  );
}

function WelcomePrinciple({
  number,
  title,
  body,
}: {
  number: string;
  title: string;
  body: string;
}) {
  return (
    <article>
      <span>{number}</span>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}
