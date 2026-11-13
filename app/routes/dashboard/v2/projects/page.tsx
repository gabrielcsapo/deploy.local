import { getRequest } from 'react-flight-router/server';
import { loadProjectPage } from '../../../../../server/v2/project-page.ts';
import { DataSeeds } from '../data/seeds';
import Projects from './page.client';
export default async function ProjectPage() {
  const page = await loadProjectPage(getRequest());
  return (
    <DataSeeds part="page" seed={page?.seed}>
      <Projects />
    </DataSeeds>
  );
}
