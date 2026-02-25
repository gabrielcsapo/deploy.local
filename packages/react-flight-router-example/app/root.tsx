import { Outlet, ScrollRestoration } from "react-flight-router/client";
import { MainNav } from "./routes/nav.client";
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
        <MainNav />
        <Outlet />
      </body>
    </html>
  );
}
