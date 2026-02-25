import { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from "react";

interface RouterContextValue {
  pathname: string;
  navigate: (to: string) => void;
}

const RouterContext = createContext<RouterContextValue | null>(null);

const BASE_PATH = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(pathname: string): string {
  if (BASE_PATH && pathname.startsWith(BASE_PATH)) {
    const stripped = pathname.slice(BASE_PATH.length);
    return stripped || "/";
  }
  return pathname;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [pathname, setPathname] = useState(() => stripBase(window.location.pathname));

  useEffect(() => {
    const onPopState = () => {
      setPathname(stripBase(window.location.pathname));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((to: string) => {
    window.history.pushState(null, "", BASE_PATH + to);
    setPathname(to);
    window.scrollTo(0, 0);
  }, []);

  return <RouterContext.Provider value={{ pathname, navigate }}>{children}</RouterContext.Provider>;
}

export function useRouter() {
  const ctx = useContext(RouterContext);
  if (!ctx) throw new Error("useRouter must be used within RouterProvider");
  return ctx;
}

export function Link({
  to,
  children,
  className,
  ...rest
}: {
  to: string;
  children: ReactNode;
  className?: string;
} & Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, "href">) {
  const { navigate } = useRouter();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }
    e.preventDefault();
    navigate(to);
  };

  return (
    <a href={BASE_PATH + to} onClick={handleClick} className={className} {...rest}>
      {children}
    </a>
  );
}

interface RouteMatch {
  params: Record<string, string>;
}

export function matchPath(pattern: string, pathname: string): RouteMatch | null {
  if (pattern === "*") {
    return { params: {} };
  }

  const patternParts = pattern.split("/").filter(Boolean);
  const pathParts = pathname.split("/").filter(Boolean);

  if (patternParts.length !== pathParts.length) {
    return null;
  }

  const params: Record<string, string> = {};

  for (let i = 0; i < patternParts.length; i++) {
    const pat = patternParts[i];
    const actual = pathParts[i];

    if (pat.startsWith(":")) {
      params[pat.slice(1)] = actual;
    } else if (pat !== actual) {
      return null;
    }
  }

  return { params };
}
