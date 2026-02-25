import { Link } from "react-flight-router/client";
import { getDefaultFullPath, EXPLORE_LEVELS } from "./explore-config.js";

export default function ExploreIndex() {
  const fullPath = getDefaultFullPath();

  return (
    <div className="p-4">
      <h2 className="text-xl font-bold mb-2">Explore - Deep Nesting Stress Test</h2>
      <p className="text-sm text-gray-600 mb-4">
        This route tree has {EXPLORE_LEVELS.length} levels of nesting to stress-test segment
        diffing. Each level shows a render timestamp to prove which levels re-rendered during
        navigation.
      </p>

      <div className="space-y-2">
        <Link
          to={fullPath}
          className="inline-block px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
          data-testid="dive-to-max-depth"
        >
          Dive to maximum depth (all {EXPLORE_LEVELS.length} levels)
        </Link>
      </div>

      <div className="mt-6 text-sm">
        <h3 className="font-semibold mb-2">Diffing Test Scenarios:</h3>
        <ol className="list-decimal list-inside space-y-1 text-gray-700">
          <li>
            <strong>Leaf-only change:</strong> Navigate between rooms at the deepest level
          </li>
          <li>
            <strong>Mid-level change:</strong> Change the city param (levels 9-14 re-render)
          </li>
          <li>
            <strong>Top-level change:</strong> Change the universe param (levels 1-14 re-render)
          </li>
          <li>
            <strong>Cross-branch:</strong> Navigate from deep explore path to /about
          </li>
          <li>
            <strong>Same route, different params:</strong> Change a single param at any level
          </li>
        </ol>
      </div>
    </div>
  );
}
