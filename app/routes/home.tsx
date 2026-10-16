import { Link } from 'react-flight-router/client';
import { AuthAwareCTA } from '../components/AuthAwareCTA.client';
import { BrandLockup } from '../components/BrandLogo';
import { CopyCommand } from '../components/CopyCommand.client';
import { LandingApplicationPreview } from './LandingApplicationPreview.client';

export default function Component() {
  return (
    <main className="welcome-home">
      <section className="welcome-hero">
        <div className="welcome-glow" aria-hidden />
        <div className="welcome-hero-copy">
          <Link to="/" className="welcome-brand" aria-label="deploy.local">
            <BrandLockup compact />
          </Link>
          <h1>
            Build with AI.
            <br />
            <em>Run it here.</em>
          </h1>
          <p className="welcome-lede">
            Code with agents, review the changes, and deploy to your own machines. Your
            repositories, conversations and running applications, together.
          </p>
          <div className="welcome-actions">
            <AuthAwareCTA />
            <Link to="/docs" className="welcome-secondary-action">
              Read the docs
            </Link>
          </div>
        </div>
        <LandingApplicationPreview />
      </section>

      <section className="welcome-principles" aria-labelledby="welcome-principles-title">
        <div className="welcome-section-copy">
          <p className="welcome-kicker">Everything in context</p>
          <h2 id="welcome-principles-title">From first prompt to running code.</h2>
          <p>Move between tasks, source and deployments without losing your place.</p>
        </div>
        <div className="welcome-principle-grid">
          <WelcomePrinciple
            title="Work with agents"
            body="Start a task in a project. Keep the conversation, source context and code review together."
          />
          <WelcomePrinciple
            title="Review the changes"
            body="Browse your repository, inspect diffs and run checks before deciding what ships."
          />
          <WelcomePrinciple
            title="Deploy on your machines"
            body="Run applications, connect services and storage, and follow deployments and logs in one workspace."
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

function WelcomePrinciple({ title, body }: { title: string; body: string }) {
  return (
    <article>
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}
