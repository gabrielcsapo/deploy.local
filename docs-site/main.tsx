import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, Navigate, RouterProvider } from 'react-router';
import './styles.css';

import Shell from './shell';
import Home from './home';
import DocsLayout from './layout';
import GettingStarted from '../app/routes/docs/index';
import Deploying from '../app/routes/docs/deploying';
import Cli from '../app/routes/docs/cli';
import Configuration from '../app/routes/docs/configuration';
import Architecture from '../app/routes/docs/architecture';

const router = createBrowserRouter(
  [
    {
      Component: Shell,
      children: [
        { index: true, Component: Home },
        {
          path: 'docs',
          Component: DocsLayout,
          children: [
            { index: true, Component: GettingStarted },
            { path: 'deploying', Component: Deploying },
            { path: 'configuration', Component: Configuration },
            { path: 'cli', Component: Cli },
            { path: 'architecture', Component: Architecture },
          ],
        },
        { path: '*', element: <Navigate to="/" replace /> },
      ],
    },
  ],
  { basename: '/deploy.sh' },
);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
