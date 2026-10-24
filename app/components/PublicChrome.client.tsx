'use client';

import { useLocation } from 'react-flight-router/client';
import { workspacePath } from '../routes/dashboard/repository-navigation';

/** Root layouts persist through Flight navigation. Decide chrome visibility on
 * the client as well as on direct requests so the footer cannot follow a user
 * from the landing page into the workspace. */
export function PublicChrome({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation();
  return workspacePath(pathname) ? null : children;
}
