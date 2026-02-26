import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  use: {
    headless: true,
  },
  projects: [
    {
      name: "production",
      testMatch: ["app.spec.ts", "auth.spec.ts"],
      use: {
        browserName: "chromium",
        baseURL: "http://localhost:3000",
      },
    },
    {
      name: "dev",
      testMatch: ["dev.spec.ts", "auth-dev.spec.ts"],
      use: {
        browserName: "chromium",
        baseURL: "http://localhost:5173",
      },
    },
    {
      name: "logging",
      testMatch: "logging.spec.ts",
      use: {
        browserName: "chromium",
      },
    },
  ],
});
