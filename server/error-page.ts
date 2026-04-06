import type { ServerResponse } from 'node:http';

interface ErrorPageOptions {
  title: string;
  heading: string;
  message: string;
  status: number;
  appName?: string;
  autoRefresh?: boolean;
  showDashboardLink?: boolean;
}

function errorPageHtml(opts: ErrorPageOptions): string {
  const dashboardUrl = opts.appName
    ? `//deploy.local/dashboard/${opts.appName}`
    : '//deploy.local/dashboard';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${opts.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0a0a0b;
      color: #e4e4e7;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      text-align: center;
      max-width: 480px;
      padding: 2rem;
    }
    .status-code {
      font-size: 4rem;
      font-weight: 700;
      color: #27272a;
      line-height: 1;
      margin-bottom: 1rem;
    }${
      opts.appName
        ? `
    .app-name {
      display: inline-block;
      padding: 0.25rem 0.75rem;
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 6px;
      font-family: 'Monaco', 'Courier New', monospace;
      font-size: 0.8125rem;
      color: #a1a1aa;
      margin-bottom: 1.25rem;
    }`
        : ''
    }${
      opts.autoRefresh
        ? `
    .spinner {
      width: 36px;
      height: 36px;
      margin: 0 auto 1.5rem;
      border: 3px solid #27272a;
      border-top-color: #a1a1aa;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }`
        : ''
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 600;
      color: #fafafa;
      margin-bottom: 0.75rem;
    }
    p {
      font-size: 0.875rem;
      color: #71717a;
      line-height: 1.6;
      margin-bottom: 1.5rem;
    }
    .actions {
      display: flex;
      gap: 0.75rem;
      justify-content: center;
    }
    .btn {
      display: inline-block;
      padding: 0.5rem 1.25rem;
      background: #27272a;
      border: 1px solid #3f3f46;
      color: #e4e4e7;
      text-decoration: none;
      border-radius: 6px;
      font-size: 0.8125rem;
      font-weight: 500;
      transition: background 0.2s, border-color 0.2s;
    }
    .btn:hover {
      background: #3f3f46;
      border-color: #52525b;
    }
  </style>${
    opts.autoRefresh
      ? `
  <script>setTimeout(() => window.location.reload(), 3000);</script>`
      : ''
  }
</head>
<body>
  <div class="container">
    <div class="status-code">${opts.status}</div>${
      opts.autoRefresh
        ? `
    <div class="spinner"></div>`
        : ''
    }${
      opts.appName
        ? `
    <div class="app-name">${opts.appName}</div>`
        : ''
    }
    <h1>${opts.heading}</h1>
    <p>${opts.message}</p>${
      opts.showDashboardLink !== false
        ? `
    <div class="actions">
      <a href="${dashboardUrl}" class="btn">Dashboard</a>
    </div>`
        : ''
    }
  </div>
</body>
</html>`;
}

export function serveErrorPage(res: ServerResponse, opts: ErrorPageOptions) {
  res.writeHead(opts.status, {
    'Content-Type': 'text/html',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(errorPageHtml(opts));
}

export function appNotFoundPage(res: ServerResponse, appName: string) {
  serveErrorPage(res, {
    title: `${appName} - Not Found`,
    heading: 'App Not Found',
    message: `There is no app named <strong>${appName}</strong> deployed on this server.`,
    status: 404,
    appName,
  });
}

export function appStartingPage(res: ServerResponse, appName: string) {
  serveErrorPage(res, {
    title: `${appName} - Starting Up`,
    heading: 'Starting Up',
    message:
      'This app is currently starting. It may take a few moments for the container to boot up. This page will automatically refresh.',
    status: 502,
    appName,
    autoRefresh: true,
  });
}

export function notFoundPage(res: ServerResponse) {
  serveErrorPage(res, {
    title: 'deploy.local - Not Found',
    heading: 'Page Not Found',
    message: 'The page you are looking for does not exist.',
    status: 404,
    showDashboardLink: true,
  });
}
