import { Header } from "../components/header";
import { Hero } from "../components/hero";
import { Link } from "../router";

const features = [
  {
    title: "React Server Components",
    description:
      "Routes are async server components that fetch data directly. No client-side data fetching libraries needed.",
    link: "/docs/guides/data-fetching",
  },
  {
    title: "Nested Layouts",
    description:
      "Compose routes via <Outlet />, sharing layouts across child routes without re-rendering parents.",
    link: "/docs/guides/layouts-and-outlets",
  },
  {
    title: "Server Actions",
    description:
      "'use server' functions callable from client components. Progressive enhancement with form actions.",
    link: "/docs/guides/server-actions",
  },
  {
    title: "SSR",
    description:
      "Production builds render full HTML on the server for fast FCP, SEO, and zero-waterfall hydration.",
    link: "/docs/guides/ssr",
  },
  {
    title: "Segment Diffing",
    description:
      "Navigation only re-renders changed segments. Shared layouts are preserved across route transitions.",
    link: "/docs/architecture/segment-diffing",
  },
  {
    title: "Streaming",
    description:
      "RSC payloads stream to the client via the React Flight protocol. No loading waterfalls.",
    link: "/docs/architecture/how-it-works",
  },
  {
    title: "Dynamic Params",
    description:
      ":id style URL segments with params passed directly to server components as props.",
    link: "/docs/guides/routing",
  },
  {
    title: "CSS Support",
    description:
      "Works with Tailwind CSS, CSS modules, or any Vite-compatible CSS tooling out of the box.",
    link: "/docs/guides/css-and-styling",
  },
];

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
            <Link
              key={feature.title}
              to={feature.link}
              className="block rounded-xl border border-gray-200 dark:border-gray-800 p-6 hover:border-blue-500 dark:hover:border-blue-400 transition-colors cursor-pointer"
            >
              <h3 className="font-semibold text-lg mb-2">{feature.title}</h3>
              <p className="text-sm text-gray-600 dark:text-gray-400">{feature.description}</p>
            </Link>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-gray-200 dark:border-gray-800 py-8">
        <div className="max-w-6xl mx-auto px-6 text-center text-sm text-gray-500 dark:text-gray-400">
          <p>MIT License</p>
          <a
            href="https://github.com/gabrielcsapo/react-flight-router"
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
