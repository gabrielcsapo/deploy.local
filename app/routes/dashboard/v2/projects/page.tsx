import { getRequest } from 'react-flight-router/server';
import { pageLoader } from '../../../../../server/page-loader.ts';
import { DataSeeds } from '../data/seeds';
import Projects from './page.client';
export default async function ProjectPage() {
  const page = await pageLoader().loadProjectPage(getRequest());
  return (
    <DataSeeds part="page" seed={page?.seed}>
      <Projects />
    </DataSeeds>
  );
}
