import { Link, Outlet } from "react-flight-router/client";
import "./styles.css";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Flight Router E2E</title>
      </head>
      <body className="font-sans leading-relaxed text-gray-900 bg-gray-50">
        <nav className="bg-white px-8 py-4 border-b border-gray-200 shadow-sm">
          <ul className="flex gap-6 list-none items-center">
            <li>
              <Link to="/" className="text-gray-700 hover:text-blue-600 font-medium">
                Home
              </Link>
            </li>
            <li>
              <Link to="/actions" className="text-gray-700 hover:text-blue-600 font-medium">
                Actions
              </Link>
            </li>
            <li>
              <Link to="/request-info" className="text-gray-700 hover:text-blue-600 font-medium">
                Request Info
              </Link>
            </li>
          </ul>
        </nav>
        <main className="max-w-4xl mx-auto px-8 py-8">
          <Outlet />
        </main>
      </body>
    </html>
  );
}
