import { Link } from "react-flight-router/client";
import { EXPLORE_LEVELS, buildExplorePath } from "./explore-config.js";

interface ExploreLeafProps {
  params: Record<string, string>;
}

export function ExploreLeaf({ params }: ExploreLeafProps) {
  const level = EXPLORE_LEVELS.length - 1;
  const config = EXPLORE_LEVELS[level];
  const timestamp = new Date().toISOString();
  const currentValue = config.paramName ? params[config.paramName] : null;

  const siblingLinks = config.sampleValues
    .filter((v) => v !== currentValue)
    .map((value) => {
      const siblingParams = { ...params, [config.paramName!]: value };
      return {
        label: value,
        href: buildExplorePath(level, siblingParams),
      };
    });

  const allParams = EXPLORE_LEVELS.filter((l) => l.paramName).map((l) => ({
    name: l.name,
    paramName: l.paramName!,
    value: params[l.paramName!] ?? "(missing)",
  }));

  return (
    <div className={`${config.borderColor} ${config.bgColor} border-l-4 pl-3 py-2 my-1`}>
      <div className="flex items-baseline gap-3 flex-wrap">
        <span className="font-bold text-sm" data-testid={`level-${config.routeId}`}>
          L{level} {config.name}: {currentValue}
        </span>
        <span
          className="text-xs text-gray-500 font-mono"
          data-testid={`timestamp-${config.routeId}`}
        >
          rendered {timestamp}
        </span>
      </div>

      <div className="flex flex-wrap gap-2 my-2 text-xs">
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
        <Link
          to="/about"
          className="px-2 py-0.5 rounded bg-white border border-red-300 hover:bg-red-50 text-red-700"
          data-testid="cross-branch-about"
        >
          Jump to /about
        </Link>
      </div>

      <div className="mt-2 p-2 bg-white rounded border border-gray-200 text-xs font-mono">
        <div className="font-semibold mb-1">All params ({allParams.length}):</div>
        {allParams.map((p) => (
          <div key={p.paramName}>
            <span className="text-gray-500">{p.name}</span>{" "}
            <span className="text-gray-400">({p.paramName})</span>={" "}
            <span className="font-medium">{p.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
