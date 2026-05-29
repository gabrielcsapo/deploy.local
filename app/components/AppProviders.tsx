'use client';

import { Toaster } from './Toaster';
import { DeployNotifications } from './DeployNotifications';

// Composes the Toaster provider with its app-level consumers inside a single
// client boundary. DeployNotifications calls useToast(), so it must live in the
// same client tree as the ToasterContext provider — authoring it here (rather
// than as a sibling in the server root layout) guarantees that nesting. Route
// content passed as `children` renders inside the provider as well.
export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <Toaster>
      {children}
      <DeployNotifications />
    </Toaster>
  );
}
