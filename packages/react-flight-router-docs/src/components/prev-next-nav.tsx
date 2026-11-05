import { Link } from "../router";
import { getPrevNext } from "../lib/navigation";

export function PrevNextNav({ currentSlug }: { currentSlug: string }) {
  const { prev, next } = getPrevNext(currentSlug);

  if (!prev && !next) return null;

  return (
    <nav className="flex items-stretch gap-4 mt-16 pt-8 border-t border-gray-200 dark:border-gray-800">
      {prev ? (
        <Link
          to={prev.path}
          className="flex-1 group rounded-lg border border-gray-200 dark:border-gray-800 p-4 hover:border-blue-500 dark:hover:border-blue-400 transition-colors"
        >
          <span className="text-sm text-gray-500 dark:text-gray-400">Previous</span>
          <span className="block font-medium mt-1 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
            {prev.title}
          </span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
      {next ? (
        <Link
          to={next.path}
          className="flex-1 group rounded-lg border border-gray-200 dark:border-gray-800 p-4 hover:border-blue-500 dark:hover:border-blue-400 transition-colors text-right"
        >
          <span className="text-sm text-gray-500 dark:text-gray-400">Next</span>
          <span className="block font-medium mt-1 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
            {next.title}
          </span>
        </Link>
      ) : (
        <div className="flex-1" />
      )}
    </nav>
  );
}
