import type { ReactNode } from 'react';
import { getRequest } from 'react-flight-router/server';
import { loadDashboardPage } from '../../../../../server/v2/project-page.ts';
import { DataSeeds } from './seeds';

/** Each route gets its own seed on navigation, even while the dashboard layout stays mounted. */
export async function DashboardPage({ children }: { children: ReactNode }) {
  const page = await loadDashboardPage(getRequest());
  return (
    <DataSeeds part="page" seed={page?.seed}>
      {children}
    </DataSeeds>
  );
}
