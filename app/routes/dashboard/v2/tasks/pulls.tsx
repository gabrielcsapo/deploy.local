import { getRequest } from 'react-flight-router/server';
import { pageLoader } from '../../../../../server/page-loader.ts';
import { DataSeeds } from '../data/seeds';
import PullRequests from './pulls.client';
export default async function Page() {
  const seed = await pageLoader().loadProjectTab(await pageLoader().loadProjectPage(getRequest()));
  return (
    <DataSeeds part="tab" seed={seed}>
      <PullRequests />
    </DataSeeds>
  );
}
