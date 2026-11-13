import { getRequest } from 'react-flight-router/server';
import { loadProjectPage } from '../../../../../server/v2/project-page.ts';
import { DataSeeds } from '../data/seeds';
import { V2Layout } from '../../v2-layout.client';
import { SessionExpired } from './SessionExpired';
export default async function Layout() {
  const page = await loadProjectPage(getRequest());
  return (
    <DataSeeds part="shell" seed={page?.seed}>
      <V2Layout />
      <SessionExpired />
    </DataSeeds>
  );
}
