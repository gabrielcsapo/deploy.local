import { Link, Outlet } from "react-flight-router/client";
import "./styles.css";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>React Flight Router Test</title>
      </head>
      <body className="font-sans leading-relaxed text-gray-900">
        <nav className="bg-gray-100 px-8 py-4 border-b border-gray-200">
          <ul className="flex gap-6 list-none">
            <li>
              <Link to="/">Home</Link>
            </li>
            <li>
              <Link to="/about">About</Link>
            </li>
            <li>
              <Link to="/dashboard">Dashboard</Link>
            </li>
            <li>
              <Link to="/posts">Blog</Link>
            </li>
            <li>
              <Link to="/explore">Explore</Link>
            </li>
          </ul>
        </nav>
        <Outlet />
      </body>
    </html>
  );
}
