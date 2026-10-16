'use client';

import { useParams } from 'react-flight-router/client';
import { ApplicationOverview } from './ApplicationOverview';
import { useDetailContext } from './shared';

/** Application health, services, and storage in a single overview. */
export default function Component() {
  const { name } = useParams();
  const { deployment } = useDetailContext();
  return <ApplicationOverview name={name!} deploymentStatus={deployment.status} />;
}
