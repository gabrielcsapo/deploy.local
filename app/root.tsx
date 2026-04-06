import { Suspense } from 'react';
import './styles.css';
import { Outlet, ScrollRestoration } from 'react-flight-router/client';
import { AppHeader, GlobalNavigationLoadingBar } from './routes/root.client';
import { AppFooter } from './components/Footer';
import { Toaster } from './components/Toaster';
import { DeployNotifications } from './components/DeployNotifications';
import { LoadingState } from './components/LoadingState';

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="Self-hosted deployment platform. Deploy and manage your applications from your own server."
        />
        <link rel="icon" type="image/png" href="/favicon-96x96.png" sizes="96x96" />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <title>deploy.local</title>
      </head>
      <body className="min-h-screen flex flex-col">
        <ScrollRestoration />
        <GlobalNavigationLoadingBar />
        <AppHeader />
        <Toaster>
          <div className="flex-1">
            <Suspense fallback={<LoadingState />}>
              <Outlet />
            </Suspense>
          </div>
          <DeployNotifications />
        </Toaster>
        <AppFooter />
      </body>
    </html>
  );
}
