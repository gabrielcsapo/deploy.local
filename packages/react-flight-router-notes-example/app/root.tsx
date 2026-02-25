import { Link, Outlet } from "react-flight-router/client";
import "./styles.css";

export default function RootLayout() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Notes App</title>
      </head>
      <body className="font-sans leading-relaxed text-gray-900 bg-gray-50">
        <nav className="bg-white px-8 py-4 border-b border-gray-200 shadow-sm">
          <ul className="flex gap-6 list-none items-center">
            <li>
              <Link to="/" className="text-gray-700 hover:text-blue-600 font-medium">
                Notes
              </Link>
            </li>
            <li>
              <Link
                to="/notes/new"
                className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 text-sm"
              >
                New Note
              </Link>
            </li>
          </ul>
        </nav>
        <Outlet />
      </body>
    </html>
  );
}
