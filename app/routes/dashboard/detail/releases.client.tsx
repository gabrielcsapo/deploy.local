'use client';

import { useCallback, useEffect, useState } from 'react';
import { ErrorBanner } from '../../../components/LoadingState';
import { WorkspaceIcon } from '../workspace-icon';
import './application-overview.css';
import BuildClient from './build.client';
import { getAuth, useDetailContext } from './shared';

interface Revision {
  digest: string;
  parentDigest: string | null;
  source: string;
  manifestFormat: string;
  createdBy: string | null;
  createdAt: string;
  active: boolean;
}

interface SpecState {
  desiredDigest: string | null;
  activeDigest: string | null;
  revisions: Revision[];
}

export default function ReleasesClient() {
  const { deployment } = useDetailContext();
  const [spec, setSpec] = useState<SpecState | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    const auth = getAuth();
    if (!auth) return;
    const headers = {
      'x-deploy-username': auth.username,
      'x-deploy-token': auth.token,
    };
    try {
      const specResponse = await fetch(
        `/api/deployments/${encodeURIComponent(deployment.name)}/application-spec`,
        { headers },
      );
      const specBody = await specResponse.json();
      if (!specResponse.ok) throw new Error(specBody.error || 'Unable to load release revisions');
      setSpec(specBody as SpecState);
      setError('');
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    }
  }, [deployment.name]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="application-deployments">
      <BuildClient />
      <details className="ao-revisions">
        <summary>
          <WorkspaceIcon name="chevron" /> Configuration history{' '}
          <span>{spec?.revisions.length ?? 0}</span>
        </summary>
        <p>Saved application changes. Saving a configuration does not deploy it.</p>
        {error && <ErrorBanner message={error} />}
        {spec?.revisions.length ? (
          spec.revisions.map((revision) => (
            <div key={revision.digest} className="ao-revision">
              <code title={revision.digest}>
                {revision.digest.replace(/^sha256:/, '').slice(0, 10)}
              </code>
              <span>{revision.source}</span>
              {revision.active ? (
                <span className="badge badge-success">Active</span>
              ) : revision.digest === spec.desiredDigest ? (
                <span className="badge badge-warning">Not deployed</span>
              ) : null}
              <time dateTime={revision.createdAt}>
                {new Date(revision.createdAt).toLocaleString()}
              </time>
            </div>
          ))
        ) : (
          <p>No saved configuration history yet.</p>
        )}
      </details>
    </div>
  );
}
