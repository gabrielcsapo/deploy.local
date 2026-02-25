import { TabsSettingsClient } from "./settings.client";

export default function TabsSettings() {
  return (
    <div data-testid="tabs-settings">
      <h2 className="text-xl font-semibold mb-2">Settings</h2>
      <p className="text-gray-600 mb-4">
        This is the settings tab. It shares the tabs layout with the overview and activity tabs.
      </p>
      <p className="text-sm text-gray-500" data-testid="tabs-settings-timestamp">
        Settings rendered at {new Date().toISOString()}
      </p>
      <TabsSettingsClient />
    </div>
  );
}
