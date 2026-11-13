import { getRequest } from 'react-flight-router/server';
import { loadProjectPage, loadProjectTab } from '../../../../../server/v2/project-page.ts';
import { DataSeeds } from '../data/seeds';
import ProjectTabContent from './content.client';
export default async function ProjectTab() {
  const seed = await loadProjectTab(await loadProjectPage(getRequest()));
  return (
    <DataSeeds part="tab" seed={seed}>
      <ProjectTabContent />
    </DataSeeds>
  );
}
