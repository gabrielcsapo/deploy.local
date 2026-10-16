'use client';
import './landing-application-preview.css';

const services = [
  {
    name: 'web',
    source: 'family.local',
    detail:
      'Application service. Open a service in the dashboard to inspect its configuration and runtime.',
    status: 'Running',
  },
  {
    name: 'worker',
    source: 'Background jobs',
    detail: 'A background service without a public route.',
    status: 'Running',
  },
  {
    name: 'database',
    source: 'PostgreSQL',
    detail: 'A database service with persistent storage.',
    status: 'Healthy',
  },
];

/** An explicitly labelled example, using the same service-list model as the workspace. */
export function LandingApplicationPreview() {
  return (
    <section className="landing-application-preview" aria-label="Example application overview">
      <header>
        <div>
          <small>Example application</small>
          <h2>family-cloud</h2>
        </div>
        <span className="landing-service-status">Running</span>
      </header>
      <p>Services</p>
      <div className="landing-service-list">
        {services.map((service) => (
          <details key={service.name}>
            <summary>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="4" y="5" width="16" height="14" rx="3" />
                <path d="m8 10 3 2-3 2m5 0h3" />
              </svg>
              <span>
                <strong>{service.name}</strong>
                <small>{service.source}</small>
              </span>
              <span className="landing-service-status">{service.status}</span>
              <svg className="landing-service-chevron" viewBox="0 0 24 24" aria-hidden="true">
                <path d="m9 6 6 6-6 6" />
              </svg>
            </summary>
            <p>{service.detail}</p>
          </details>
        ))}
      </div>
      <footer>
        <small>Illustrative data · Expand a service to inspect this example.</small>
      </footer>
    </section>
  );
}
