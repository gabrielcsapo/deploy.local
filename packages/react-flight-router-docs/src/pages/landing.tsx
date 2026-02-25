import { Link } from "../router";
import { Header } from "../components/header";
import { Hero } from "../components/hero";
import { HighlightedCode } from "../components/highlighted-code";

const features = [
  {
    title: "React Server Components",
    description:
      "Routes are async server components that fetch data directly. No client-side data fetching libraries needed.",
  },
  {
    title: "Nested Layouts",
    description:
      "Compose routes via <Outlet />, sharing layouts across child routes without re-rendering parents.",
  },
  {
    title: "Server Actions",
    description:
      "'use server' functions callable from client components. Progressive enhancement with form actions.",
  },
  {
    title: "SSR",
    description:
      "Production builds render full HTML on the server for fast FCP, SEO, and zero-waterfall hydration.",
  },
  {
    title: "Segment Diffing",
    description:
      "Navigation only re-renders changed segments. Shared layouts are preserved across route transitions.",
  },
  {
    title: "Streaming",
    description:
      "RSC payloads stream to the client via the React Flight protocol. No loading waterfalls.",
  },
  {
    title: "Dynamic Params",
    description:
      ":id style URL segments with params passed directly to server components as props.",
  },
  {
    title: "CSS Support",
    description:
      "Works with Tailwind CSS, CSS modules, or any Vite-compatible CSS tooling out of the box.",
  },
];

const quickStartCode = `# Create a new project
mkdir my-app && cd my-app
npm init -y
npm install react react-dom react-server-dom-webpack flight-router hono @hono/node-server
npm install -D vite @vitejs/plugin-react typescript`;

const routeConfigCode = `// app/routes.ts
import type { RouteConfig } from "flight-router/router";

export const routes: RouteConfig[] = [
  {
    id: "root",
    path: "",
    component: () => import("./root.js"),
    children: [
      {
        id: "home",
        index: true,
        component: () => import("./routes/home.js"),
      },
      {
        id: "about",
        path: "about",
        component: () => import("./routes/about.js"),
      },
    ],
  },
];`;

const viteConfigCode = `// vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { flightRouter } from "flight-router/dev";

export default defineConfig({
  plugins: [
    react(),
    flightRouter({ routesFile: "./app/routes.ts" }),
  ],
});`;

export function LandingPage() {
  return (
    <div className="min-h-screen bg-white dark:bg-gray-950 text-gray-900 dark:text-gray-100">
      <Header />
      <Hero />

      {/* Features Grid */}
      <section className="max-w-6xl mx-auto px-6 py-20">
        <h2 className="text-3xl font-bold text-center mb-12">Features</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {features.map((feature) => (
            <div
              key={feature.title}
              className="rounded-xl border border-gray-200 dark:border-gray-800 p-6 hover:border-blue-500 dark:hover:border-blue-400 transition-colors"
            >
              <h3 className="font-semibold text-lg mb-2">{feature.title}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">{feature.description}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Quick Start */}
      <section className="bg-gray-50 dark:bg-gray-900 py-20">
        <div className="max-w-4xl mx-auto px-6">
          <h2 className="text-3xl font-bold text-center mb-12">Get Started in Minutes</h2>

          <div className="space-y-8">
            <div>
              <h3 className="text-lg font-semibold mb-3">1. Install</h3>
              <HighlightedCode code={quickStartCode} language="bash" />
            </div>

            <div>
              <h3 className="text-lg font-semibold mb-3">2. Configure Routes</h3>
              <HighlightedCode code={routeConfigCode} language="ts" />
            </div>

            <div>
              <h3 className="text-lg font-semibold mb-3">3. Add Vite Plugin</h3>
              <HighlightedCode code={viteConfigCode} language="ts" />
            </div>
          </div>

          <div className="text-center mt-12">
            <Link
              to="/docs/getting-started/installation"
              className="inline-block bg-blue-600 hover:bg-blue-700 text-white font-semibold px-8 py-3 rounded-lg transition-colors"
            >
              Read the Full Guide
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 py-8">
        <div className="max-w-6xl mx-auto px-6 text-center text-sm text-gray-500 dark:text-gray-400">
          <p>MIT License</p>
          <a
            href="https://github.com/gabrielcsapo/flight-router"
            className="hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
