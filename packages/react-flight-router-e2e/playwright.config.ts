import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  use: {
    headless: true,
  },
  projects: [
    {
      name: "workers",
      testMatch: "workers.spec.ts",
      use: {
        browserName: "chromium",
        baseURL: "http://localhost:3002",
      },
    },
    {
      name: "no-workers",
      testMatch: "no-workers.spec.ts",
      use: {
        browserName: "chromium",
        baseURL: "http://localhost:3003",
      },
    },
    {
      name: "redirect",
      testMatch: "redirect.spec.ts",
      use: {
        browserName: "chromium",
        baseURL: "http://localhost:3004",
      },
    },
    {
      name: "slots",
      testMatch: "slots.spec.ts",
      use: {
        browserName: "chromium",
        baseURL: "http://localhost:3005",
      },
    },
    {
      // The spec internally spawns BOTH a production server (port 3006) and
      // a vite dev server (port 3007) in two describe blocks. Each block
      // builds its own URLs, so no project-level baseURL is set.
      name: "search-params",
      testMatch: "search-params.spec.ts",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
