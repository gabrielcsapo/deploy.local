import { Link, useRouter } from "../router";
import { navigation } from "./sidebar-nav";

export function Sidebar() {
  const { pathname } = useRouter();

  return (
    <nav className="py-6 pr-4 text-sm" aria-label="Documentation sidebar">
      {navigation.map((section) => (
        <div key={section.title} className="mb-6">
          <h3 className="font-semibold text-gray-900 dark:text-gray-100 mb-2 px-3">
            {section.title}
          </h3>
          <ul className="space-y-0.5">
            {section.items.map((item) => {
              const isActive = pathname === item.path;
              return (
                <li key={item.slug}>
                  <Link
                    to={item.path}
                    className={`block px-3 py-1.5 rounded-md transition-colors ${
                      isActive
                        ? "bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-medium"
                        : "text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-50 dark:hover:bg-gray-900"
                    }`}
                  >
                    {item.title}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
