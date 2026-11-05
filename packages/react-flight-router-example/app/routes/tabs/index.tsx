import { TabsOverviewClient } from "./index.client";

export default function TabsIndex() {
  return (
    <div data-testid="tabs-index">
      <h2 className="text-xl font-semibold mb-2">Overview</h2>
      <p className="text-gray-600 mb-4">
        This is the index route of the tabs layout. It tests the pattern where route IDs share a
        common prefix (tabs vs tabs-index).
      </p>
      <p className="text-sm text-gray-500" data-testid="tabs-index-timestamp">
        Index rendered at {new Date().toISOString()}
      </p>
      <TabsOverviewClient />
    </div>
  );
}
