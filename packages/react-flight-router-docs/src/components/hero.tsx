import { Link } from "../router";

export function Hero() {
  return (
    <section className="relative overflow-hidden">
      {/* Background gradient */}
      <div className="absolute inset-0 bg-gradient-to-br from-blue-50 via-white to-purple-50 dark:from-gray-950 dark:via-gray-900 dark:to-blue-950" />

      <div className="relative max-w-4xl mx-auto px-6 py-24 md:py-32 text-center">
        <h1 className="text-5xl md:text-6xl font-extrabold tracking-tight mb-6">
          <span className="bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent">
            React Flight Router
          </span>
        </h1>

        <p className="text-xl md:text-2xl text-gray-600 dark:text-gray-300 mb-4 max-w-2xl mx-auto">
          React Server Components routing for Vite
        </p>

        <p className="text-lg text-gray-500 dark:text-gray-400 mb-10 max-w-xl mx-auto">
          Server-rendered routes with streaming, nested layouts, server actions, and segment
          diffing. Built on the React Flight protocol.
        </p>

        <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            to="/docs/getting-started/installation"
            className="inline-flex items-center bg-blue-600 hover:bg-blue-700 text-white font-semibold px-8 py-3 rounded-lg transition-colors text-lg"
          >
            Get Started
            <svg
              className="w-5 h-5 ml-2"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" />
            </svg>
          </Link>
          <a
            href="https://github.com/gabrielcsapo/react-flight-router"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center border border-gray-300 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-600 text-gray-700 dark:text-gray-300 font-semibold px-8 py-3 rounded-lg transition-colors text-lg"
          >
            <svg className="w-5 h-5 mr-2" fill="currentColor" viewBox="0 0 24 24">
              <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
            </svg>
            GitHub
          </a>
        </div>
      </div>
    </section>
  );
}
