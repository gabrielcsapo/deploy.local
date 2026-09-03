import { Link } from 'react-router';
import { CopyCommand } from '../app/components/CopyCommand.client';
import { PublicCloudGraph } from '../app/routes/home.client';

declare const __APP_VERSION__: string;

export default function Home() {
  return (
    <main className="public-home">
      <section className="public-home-hero">
        <div className="public-home-grid" aria-hidden="true" />
        <div className="public-home-frame">
          <div className="public-home-intro">
            <div>
              <p className="public-home-kicker">
                <span /> One authority · every place you run
              </p>
              <h1>
                Your applications have a home. <em>Your cloud can leave it.</em>
              </h1>
            </div>
            <aside>
              <span>Personal application cloud · v{__APP_VERSION__}</span>
              <p>
                Deploy to hardware you trust, understand the whole operating graph, and carry
                selected applications offline without creating another control plane.
              </p>
              <div className="public-home-actions">
                <Link to="/docs" className="btn btn-primary no-underline">
                  Open the field guide
                </Link>
                <a
                  href="https://github.com/gabrielcsapo/deploy.local"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="btn no-underline"
                >
                  View source
                </a>
              </div>
            </aside>
          </div>
          <PublicCloudGraph />
        </div>
      </section>

      <section className="public-home-system">
        <div className="public-section-heading">
          <p className="eyebrow">The operating model</p>
          <h2>A cloud is not a machine. It is the graph between them.</h2>
          <p>
            Home coordinates identity and history. Machines contribute compute. Suitcases carry
            admitted application boundaries and remain useful while disconnected.
          </p>
        </div>
      </section>

      <section className="public-home-start">
        <div>
          <p className="eyebrow">Start with one Home</p>
          <h2>Install the authority. Add places when you need them.</h2>
          <p>The first deployment stays small; the same graph grows with the hardware you add.</p>
          <div className="public-home-actions">
            <Link to="/docs" className="btn btn-primary no-underline">
              Start with the docs
            </Link>
          </div>
        </div>
        <div className="public-install-panel">
          <div className="public-install-panel-head">
            <span>Install deploy.local</span>
            <small>macOS · Linux · Windows with Docker</small>
          </div>
          <CopyCommand command="curl -fsSL deploy.local/install | sh" />
        </div>
      </section>
    </main>
  );
}
