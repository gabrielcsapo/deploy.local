import { getRequest } from 'react-flight-router/server';
import { pageLoader } from '../../../../../server/page-loader.ts';
import { DataSeeds } from '../data/seeds';
import Releases from './page.client';
export default async function Page() {
  const seed = await pageLoader().loadProjectTab(await pageLoader().loadProjectPage(getRequest()));
  return (
    <DataSeeds part="tab" seed={seed}>
      <Releases key={getRequest()?.url} />
    </DataSeeds>
  );
}
