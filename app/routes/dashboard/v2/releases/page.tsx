import { getRequest } from 'react-flight-router/server';
import { loadProjectPage, loadProjectTab } from '../../../../../server/v2/project-page.ts';
import { DataSeeds } from '../data/seeds';
import Releases from './page.client';
export default async function Page() {
  const seed = await loadProjectTab(await loadProjectPage(getRequest()));
  return (
    <DataSeeds part="tab" seed={seed}>
      <Releases key={getRequest()?.url} />
    </DataSeeds>
  );
}
