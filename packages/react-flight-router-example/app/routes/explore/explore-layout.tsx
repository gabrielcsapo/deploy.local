import { Link, Outlet } from "react-flight-router/client";
import { EXPLORE_LEVELS, buildExplorePath } from "./explore-config.js";

interface ExploreLayoutProps {
  level: number;
  params: Record<string, string>;
}

export function ExploreLayout({ level, params }: ExploreLayoutProps) {
  const config = EXPLORE_LEVELS[level];
  const timestamp = new Date().toISOString();
  const currentValue = config.paramName ? params[config.paramName] : null;

  // Build full-depth paths (no index routes at intermediate levels)
  const maxLevel = EXPLORE_LEVELS.length - 1;

  const siblingLinks = config.paramName
    ? config.sampleValues
        .filter((v) => v !== currentValue)
        .map((value) => {
          const siblingParams = { ...params, [config.paramName!]: value };
          return {
            label: value,
            href: buildExplorePath(maxLevel, siblingParams),
          };
        })
    : [];

  const cousinLinks: Array<{ label: string; href: string }> = [];
  if (level >= 2) {
    const parentConfig = EXPLORE_LEVELS[level - 1];
    if (parentConfig.paramName) {
      const currentParentValue = params[parentConfig.paramName];
      for (const altValue of parentConfig.sampleValues) {
        if (altValue !== currentParentValue) {
          const altParams = { ...params, [parentConfig.paramName]: altValue };
          cousinLinks.push({
            label: `Change ${parentConfig.name} to ${altValue}`,
            href: buildExplorePath(maxLevel, altParams),
          });
          break;
        }
      }
    }
  }

  return (
    <div className={`${config.borderColor} ${config.bgColor} border-l-4 pl-3 py-2 my-1`}>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-semibold text-sm" data-testid={`level-${config.routeId}`}>
          L{level} {config.name}
          {currentValue ? `: ${currentValue}` : ""}
        </span>
        <span
          className="text-xs text-gray-500 font-mono"
          data-testid={`timestamp-${config.routeId}`}
        >
          rendered {timestamp}
        </span>
      </div>

      {(siblingLinks.length > 0 || cousinLinks.length > 0) && (
        <div className="flex flex-wrap gap-2 my-1 text-xs">
          {siblingLinks.map((link) => (
            <Link
              key={link.href}
              to={link.href}
              className="px-2 py-0.5 rounded bg-white border border-gray-300 hover:bg-gray-100 text-blue-700"
              data-testid={`sibling-${config.routeId}`}
            >
              {link.label}
            </Link>
          ))}
          {cousinLinks.map((link) => (
            <Link
              key={link.href}
              to={link.href}
              className="px-2 py-0.5 rounded bg-white border border-orange-300 hover:bg-orange-50 text-orange-700"
              data-testid={`cousin-${config.routeId}`}
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}

      <Outlet />
    </div>
  );
}
