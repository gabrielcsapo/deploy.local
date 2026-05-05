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
        title: "Your First Route",
        slug: "getting-started/first-route",
        path: "/docs/getting-started/first-route",
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
        title: "Navigation & Links",
        slug: "guides/navigation-and-links",
        path: "/docs/guides/navigation-and-links",
      },
      {
        title: "Layouts & Outlets",
        slug: "guides/layouts-and-outlets",
        path: "/docs/guides/layouts-and-outlets",
      },
      {
        title: "Parallel Routes & Modals",
        slug: "guides/parallel-routes",
        path: "/docs/guides/parallel-routes",
      },
      {
        title: "Data Fetching",
        slug: "guides/data-fetching",
        path: "/docs/guides/data-fetching",
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
        title: "Request Context",
        slug: "guides/request-context",
        path: "/docs/guides/request-context",
      },
      {
        title: "Search Params",
        slug: "guides/search-params",
        path: "/docs/guides/search-params",
      },
      {
        title: "Loading & Suspense",
        slug: "guides/loading-and-suspense",
        path: "/docs/guides/loading-and-suspense",
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
        title: "Redirects",
        slug: "guides/redirect",
        path: "/docs/guides/redirect",
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
        title: "Worker Threads",
        slug: "guides/worker-threads",
        path: "/docs/guides/worker-threads",
      },
      {
        title: "Scroll Restoration",
        slug: "guides/scroll-restoration",
        path: "/docs/guides/scroll-restoration",
      },
      {
        title: "Debugging & Performance",
        slug: "guides/debugging",
        path: "/docs/guides/debugging",
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
