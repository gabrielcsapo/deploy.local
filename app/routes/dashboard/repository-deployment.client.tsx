'use client';
import { useEffect, useState } from 'react';
import { Link } from 'react-flight-router/client';
import { fetchDeployment } from '../../actions/deployments';
import { getAuth } from './detail/shared';

export function RepositoryDeploymentView({
  configuration,
}: {
  configuration?: { application?: string; error?: string; commit?: string };
}) {
  const [available, setAvailable] = useState(false);
  const [message, setMessage] = useState('Checking application…');
  const application = configuration?.application;
  useEffect(() => {
    let cancelled = false;
    setAvailable(false);
    const auth = getAuth();
    if (!application || !auth) return;
    setMessage('Checking application…');
    void fetchDeployment(auth.username, auth.token, application)
      .then(() => {
        if (!cancelled) {
          setAvailable(true);
          setMessage('');
        }
      })
      .catch((error: Error) => {
        if (!cancelled)
          setMessage(
            /not found/i.test(error.message)
              ? 'This application has not been created yet. Its deployment views will be available after creation.'
              : 'Could not load the application. Check your connection and sign-in.',
          );
      });
    return () => {
      cancelled = true;
    };
  }, [application]);
  return (
    <div className="ph-repository">
      <h3>{application || 'Deployment configuration'}</h3>
      <p className="pw-muted">deploy.yaml on main</p>
      {configuration?.error ? (
        <p role="alert">{configuration.error}</p>
      ) : !application ? (
        <p>
          Set metadata.name or pipeline.deploy.application in deploy.yaml to connect an application.
        </p>
      ) : (
        <>
          {message && <p role="status">{message}</p>}
          <nav className="ph-actions" aria-label="Deployment sections">
            {[
              ['', 'Architecture'],
              ['releases', 'Builds'],
              ['logs', 'Logs'],
              ['traffic', 'Observability'],
              ['settings', 'Settings'],
            ].map(([path, label]) =>
              available ? (
                <Link
                  key={label}
                  to={`/dashboard/${encodeURIComponent(application)}${path ? '/' + path : ''}`}
                >
                  {label}
                </Link>
              ) : (
                <button key={label} disabled title={message}>
                  {label}
                </button>
              ),
            )}
          </nav>
        </>
      )}
    </div>
  );
}
