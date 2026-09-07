'use client';

import { useParams } from 'react-flight-router/client';
import { ApplicationWorkspaceCanvas } from './ApplicationWorkspaceCanvas';
import { useDetailContext } from './shared';

/** The application overview is always its live service graph. */
export default function Component() {
  const { name } = useParams();
  const { deployment } = useDetailContext();
  return <ApplicationWorkspaceCanvas name={name!} deploymentStatus={deployment.status} />;
}
