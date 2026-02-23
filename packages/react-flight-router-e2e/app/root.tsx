import { Link, Outlet } from 'flight-router/client';

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Flight Router Test</title>
        <style>{`
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: system-ui, -apple-system, sans-serif; line-height: 1.6; color: #1a1a1a; }
          nav { background: #f5f5f5; padding: 1rem 2rem; border-bottom: 1px solid #e0e0e0; }
          nav ul { list-style: none; display: flex; gap: 1.5rem; }
          nav a { color: #0066cc; text-decoration: none; font-weight: 500; }
          nav a:hover { text-decoration: underline; }
          main { max-width: 800px; margin: 2rem auto; padding: 0 2rem; }
          h1 { margin-bottom: 1rem; }
          h2 { margin: 1.5rem 0 0.5rem; }
          p { margin-bottom: 1rem; }
          button { padding: 0.5rem 1rem; background: #0066cc; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 1rem; }
          button:hover { background: #0052a3; }
          button:disabled { opacity: 0.6; cursor: not-allowed; }
          input { padding: 0.5rem; border: 1px solid #ccc; border-radius: 4px; font-size: 1rem; }
          .card { background: white; border: 1px solid #e0e0e0; border-radius: 8px; padding: 1.5rem; margin-bottom: 1rem; }
          .timestamp { color: #666; font-size: 0.875rem; }
        `}</style>
      </head>
      <body>
        <nav>
          <ul>
            <li><Link to="/">Home</Link></li>
            <li><Link to="/about">About</Link></li>
            <li><Link to="/dashboard">Dashboard</Link></li>
            <li><Link to="/dashboard/settings">Settings</Link></li>
          </ul>
        </nav>
        <Outlet />
      </body>
    </html>
  );
}
