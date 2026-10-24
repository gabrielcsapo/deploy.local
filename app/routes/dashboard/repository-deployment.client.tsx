'use client';
import { useEffect, useState } from 'react';
import { fetchDeployment } from '../../actions/deployments';
import { getAuth } from './detail/shared';
import { ListRow, WorkspaceIcon, type WorkspaceIconName } from '@/components/ui';
import './repository-management.css';

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
  const sections: [string, string, WorkspaceIconName][] = [
    ['', 'Architecture', 'grid'],
    ['releases', 'Builds', 'bolt'],
    ['logs', 'Logs', 'terminal'],
    ['traffic', 'Observability', 'review'],
    ['settings', 'Settings', 'settings'],
  ];
  return (
    <div className="rd-deployment">
      <header className="ui-list-header">
        <WorkspaceIcon name="grid" />
        <span className="ui-list-copy">
          <strong className="ui-list-title">{application || 'Deployment configuration'}</strong>
          <span className="ui-list-secondary">deploy.yaml on main</span>
        </span>
      </header>
      {configuration?.error ? (
        <p className="ds-feedback rd-error" role="alert">
          <WorkspaceIcon name="alert" />
          <span>{configuration.error}</span>
        </p>
      ) : !application ? (
        <p className="ds-feedback">
          Set metadata.name or pipeline.deploy.application in deploy.yaml to connect an application.
        </p>
      ) : (
        <>
          {message && (
            <p className="ds-feedback" role="status">
              {message}
            </p>
          )}
          <nav aria-label="Deployment sections">
            {sections.map(([path, label, icon]) =>
              available ? (
                <ListRow
                  key={label}
                  to={`/dashboard/${encodeURIComponent(application)}${path ? '/' + path : ''}`}
                  icon={icon}
                  title={label}
                  secondary=""
                  status={<WorkspaceIcon name="chevron" />}
                />
              ) : (
                <div key={label} className="ui-list-row" aria-disabled="true" title={message}>
                  <span className="ui-list-link">
                    <WorkspaceIcon name={icon} />
                    <span className="ui-list-copy">
                      <span className="ui-list-title">{label}</span>
                    </span>
                  </span>
                </div>
              ),
            )}
          </nav>
        </>
      )}
    </div>
  );
}
