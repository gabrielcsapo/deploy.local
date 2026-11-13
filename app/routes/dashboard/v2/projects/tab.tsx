import { getRequest } from 'react-flight-router/server';
import { pageLoader } from '../../../../../server/page-loader.ts';
import { DataSeeds } from '../data/seeds';
import ProjectTabContent from './content.client';
export default async function ProjectTab() {
  const seed = await pageLoader().loadProjectTab(await pageLoader().loadProjectPage(getRequest()));
  return (
    <DataSeeds part="tab" seed={seed}>
      <ProjectTabContent />
    </DataSeeds>
  );
}
