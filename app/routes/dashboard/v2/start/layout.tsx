import { getRequest } from 'react-flight-router/server';
import { pageLoader } from '../../../../../server/page-loader.ts';
import { DataSeeds } from '../data/seeds';
import { V2Layout } from '../../v2-layout.client';
import { SessionExpired } from './SessionExpired';
export default async function Layout() {
  const page = await pageLoader().loadDashboardPage(getRequest());
  return (
    <DataSeeds part="shell" seed={await page?.shellSeed()}>
      <V2Layout />
      <SessionExpired />
    </DataSeeds>
  );
}
