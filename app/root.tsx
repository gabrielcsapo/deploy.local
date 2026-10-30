import { Suspense } from 'react';
import './styles.css';
import designTokens from './design-tokens.json';
import { Outlet, ScrollRestoration } from 'react-flight-router/client';
import { GlobalNavigationLoadingBar } from './routes/root.client';
import { AppProviders } from './components/AppProviders';
import { LoadingState } from './components/LoadingState';

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="theme-color"
          content={designTokens.color.light.canvas}
          media="(prefers-color-scheme: light)"
        />
        <meta
          name="theme-color"
          content={designTokens.color.dark.canvas}
          media="(prefers-color-scheme: dark)"
        />
        <meta
          name="description"
          content="Code with agents, review changes, and deploy applications across your own machines."
        />
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="icon" type="image/png" sizes="96x96" href="/favicon-96x96.png" />
        <link rel="shortcut icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/site.webmanifest" />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/inter-variable.woff2"
          crossOrigin="anonymous"
        />
        <link
          rel="preload"
          as="font"
          type="font/woff2"
          href="/fonts/jetbrains-mono-variable.woff2"
          crossOrigin="anonymous"
        />
        <title>deploy.local</title>
      </head>
      <body className="min-h-screen flex flex-col">
        <ScrollRestoration />
        <GlobalNavigationLoadingBar />
        <AppProviders>
          <div className="flex-1">
            <Suspense fallback={<LoadingState />}>
              <Outlet />
            </Suspense>
          </div>
        </AppProviders>
      </body>
    </html>
  );
}
