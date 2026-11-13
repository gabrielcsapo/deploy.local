'use client';
import { createContext, useContext, Suspense, type ReactNode } from 'react';
import { Outlet } from 'react-flight-router/client';
import { Skeleton } from '@/components/ui';
const ProjectContent = createContext<ReactNode>(null);
/** The layout retains the chrome and data while only the child route may suspend. */
export function ProjectPanel({ children }: { children: ReactNode }) {
  return (
    <ProjectContent.Provider value={children}>
      <Suspense fallback={<Skeleton rows={4} />}>
        <Outlet />
      </Suspense>
    </ProjectContent.Provider>
  );
}
export default function ProjectTabContent() {
  return useContext(ProjectContent);
}
