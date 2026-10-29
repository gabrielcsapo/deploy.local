import { Icon, type IconName } from '../../../components/ui/v2/shared';
import { PublicPage, PublicFooter, sourceUrl } from './chrome';
import { InstallCommand } from './install.client';
import liveScreenshot from './live-1440.png';
import livePhoneScreenshot from './live-phone.png';

const pillars: [IconName, string, string][] = [
  [
    'compose',
    'Ask from anywhere',
    'Type what you want on any device. A question gets an answer. A change becomes a task on a computer that is free.',
  ],
  [
    'merge',
    'Review, then ship',
    'Every change arrives as a pull request with its checks and screenshots you ask for. Nothing goes live until you press Ship.',
  ],
  [
    'pulse',
    'Watched while it runs',
    'deploy.local checks every release. When one fails, it asks you, with the rollback ready to go.',
  ],
];
const computers = [
  { name: 'SER', detail: 'The coordinator. Stays on.', roles: ['Run apps'] },
  {
    name: 'MacBook Pro',
    detail: 'Your laptop, when it is awake',
    roles: ['Take tasks', 'Use the screen'],
  },
  {
    name: 'bazzite',
    detail: 'A desktop with a GPU',
    roles: ['Run apps', 'Serve models', 'Take tasks'],
  },
];
const devices: [IconName, string, string][] = [
  ['cloud', 'Web', 'Everything, in any browser at home'],
  ['panel', 'iPhone', 'Waiting on you, Live, and asking for work'],
  ['computer', 'Desktop app', 'Mac, Windows, Linux. Joins as a worker'],
  ['terminal', 'CLI', 'deploy, status, inbox, rollback'],
];
export default function About() {
  return (
    <PublicPage>
      <main>
        <section className="public-container public-hero">
          <h1>
            Build it with agents.
            <br />
            Run it at home.
          </h1>
          <p>
            deploy.local runs on computers you already own. Ask for an app or a change, review what
            the agent did, and ship it when you are ready.
          </p>
          <InstallCommand />
          <div className="dl-actions">
            <a className="dl-btn secondary" href="/docs">
              Read the docs
            </a>
            <a className="dl-btn quiet" href={sourceUrl}>
              View source
            </a>
          </div>
        </section>
        <div className="public-container">
          <picture className="public-preview">
            <source media="(max-width: 599px)" srcSet={livePhoneScreenshot} />
            <img
              src={liveScreenshot}
              alt="Live shows apps grouped by computer, their health, and a rollback decision."
              width="1440"
              height="1100"
            />
          </picture>
        </div>
        <section className="public-container public-pillars" aria-label="Build, ship and run">
          {pillars.map(([icon, title, body]) => (
            <article key={title}>
              <span className="public-icon">
                <Icon name={icon} size={18} />
              </span>
              <h3>{title}</h3>
              <p>{body}</p>
            </article>
          ))}
        </section>
        <section className="public-container public-computers">
          <div>
            <h2>On computers you already own.</h2>
            <p>
              One computer is enough to start. Add others and give each one a job. Models run where
              you choose: Claude or Codex with your own subscription, or an open model on your own
              GPU.
            </p>
          </div>
          <div className="dl-group">
            {computers.map((computer) => (
              <div className="dl-item" key={computer.name}>
                <span className="dl-glyph plain">
                  <Icon name="computer" size={12} />
                </span>
                <span className="dl-t">
                  <span>{computer.name}</span>
                  <span>{computer.detail}</span>
                </span>
                <span className="public-roles">
                  {computer.roles.map((role) => (
                    <span key={role} className="dl-tag">
                      {role}
                    </span>
                  ))}
                </span>
              </div>
            ))}
          </div>
        </section>
        <section className="public-container public-devices">
          <h2>Wherever you are.</h2>
          <div>
            {devices.map(([icon, title, body]) => (
              <article key={title}>
                <span className="public-icon">
                  <Icon name={icon} size={18} />
                </span>
                <div>
                  <h3>{title}</h3>
                  <p className="dl-meta">{body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>
      </main>
      <PublicFooter />
    </PublicPage>
  );
}
