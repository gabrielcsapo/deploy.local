"use client";

import { useState } from "react";

export function TabsSettingsClient() {
  const [theme, setTheme] = useState("light");

  return (
    <div className="mt-4 p-4 bg-gray-50 rounded" data-testid="tabs-settings-interactive">
      <p className="text-sm font-medium text-gray-800 mb-2">Theme Setting</p>
      <p className="text-sm text-gray-700" data-testid="tabs-settings-theme">
        Theme: {theme}
      </p>
      <div className="flex gap-2 mt-2">
        <button
          onClick={() => setTheme("light")}
          className={`px-3 py-1 rounded text-sm ${theme === "light" ? "bg-gray-800 text-white" : "bg-gray-200 text-gray-700"}`}
          data-testid="tabs-settings-light"
        >
          Light
        </button>
        <button
          onClick={() => setTheme("dark")}
          className={`px-3 py-1 rounded text-sm ${theme === "dark" ? "bg-gray-800 text-white" : "bg-gray-200 text-gray-700"}`}
          data-testid="tabs-settings-dark"
        >
          Dark
        </button>
      </div>
    </div>
  );
}
