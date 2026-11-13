import type { ReactNode } from 'react';
import { getRequest } from 'react-flight-router/server';
import { pageLoader } from '../../../../../server/page-loader.ts';
import { DataSeeds } from './seeds';

/** Each route gets its own seed on navigation, even while the dashboard layout stays mounted. */
export async function DashboardPage({ children }: { children: ReactNode }) {
  const page = await pageLoader().loadDashboardPage(getRequest());
  return (
    <DataSeeds part="page" seed={page?.seed}>
      {children}
    </DataSeeds>
  );
}
