import { Outlet, ScrollRestoration } from "react-flight-router/client";
import { MainNav } from "./routes/nav.client";
import { AuthNav } from "./routes/auth-nav.client";
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
        <ScrollRestoration />
        <div className="bg-gray-100 px-8 py-4 border-b border-gray-200 flex items-center justify-between">
          <MainNav />
          <AuthNav />
        </div>
        <Outlet />
      </body>
    </html>
  );
}
