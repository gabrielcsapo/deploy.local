export interface NavItem {
  title: string;
  slug: string;
  path: string;
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const navigation: NavSection[] = [
  {
    title: "Getting Started",
    items: [
      {
        title: "Installation",
        slug: "getting-started/installation",
        path: "/docs/getting-started/installation",
      },
      {
        title: "Project Structure",
        slug: "getting-started/project-structure",
        path: "/docs/getting-started/project-structure",
      },
      {
        title: "Vite Configuration",
        slug: "getting-started/vite-config",
        path: "/docs/getting-started/vite-config",
      },
      {
        title: "Your First Route",
        slug: "getting-started/first-route",
        path: "/docs/getting-started/first-route",
      },
    ],
  },
  {
    title: "Guides",
    items: [
      {
        title: "Routing",
        slug: "guides/routing",
        path: "/docs/guides/routing",
      },
      {
        title: "Layouts & Outlets",
        slug: "guides/layouts-and-outlets",
        path: "/docs/guides/layouts-and-outlets",
      },
      {
        title: "Data Fetching",
        slug: "guides/data-fetching",
        path: "/docs/guides/data-fetching",
      },
      {
        title: "Suspense & Streaming",
        slug: "guides/suspense",
        path: "/docs/guides/suspense",
      },
      {
        title: "Client Components",
        slug: "guides/client-components",
        path: "/docs/guides/client-components",
      },
      {
        title: "Server Actions",
        slug: "guides/server-actions",
        path: "/docs/guides/server-actions",
      },
      {
        title: "Worker Threads",
        slug: "guides/worker-threads",
        path: "/docs/guides/worker-threads",
      },
      {
        title: "CSS & Styling",
        slug: "guides/css-and-styling",
        path: "/docs/guides/css-and-styling",
      },
      {
        title: "SSR",
        slug: "guides/ssr",
        path: "/docs/guides/ssr",
      },
      {
        title: "Navigation & Links",
        slug: "guides/navigation-and-links",
        path: "/docs/guides/navigation-and-links",
      },
      {
        title: "Search Params",
        slug: "guides/search-params",
        path: "/docs/guides/search-params",
      },
      {
        title: "Scroll Restoration",
        slug: "guides/scroll-restoration",
        path: "/docs/guides/scroll-restoration",
      },
      {
        title: "Loading Handling",
        slug: "guides/loading",
        path: "/docs/guides/loading",
      },
      {
        title: "Error Handling",
        slug: "guides/error",
        path: "/docs/guides/error",
      },
      {
        title: "Not Found Handling",
        slug: "guides/not-found",
        path: "/docs/guides/not-found",
      },
      {
        title: "Debugging & Performance",
        slug: "guides/debugging",
        path: "/docs/guides/debugging",
      },
      {
        title: "Request Context",
        slug: "guides/request-context",
        path: "/docs/guides/request-context",
      },
    ],
  },
  {
    title: "API Reference",
    items: [
      {
        title: "Route Config",
        slug: "api-reference/route-config",
        path: "/docs/api-reference/route-config",
      },
      {
        title: "Client Exports",
        slug: "api-reference/client-exports",
        path: "/docs/api-reference/client-exports",
      },
      {
        title: "Server Exports",
        slug: "api-reference/server-exports",
        path: "/docs/api-reference/server-exports",
      },
    ],
  },
  {
    title: "Architecture",
    items: [
      {
        title: "How It Works",
        slug: "architecture/how-it-works",
        path: "/docs/architecture/how-it-works",
      },
      {
        title: "Build Pipeline",
        slug: "architecture/build-pipeline",
        path: "/docs/architecture/build-pipeline",
      },
      {
        title: "Segment Diffing",
        slug: "architecture/segment-diffing",
        path: "/docs/architecture/segment-diffing",
      },
    ],
  },
];
