import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
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
  ],
});
