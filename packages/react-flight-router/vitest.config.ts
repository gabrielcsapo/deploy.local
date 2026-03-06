import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    // worker-pool tests spawn real Worker threads and need compiled JS files,
    // so they run via node:test against the dist/ output instead.
    exclude: ["src/server/worker-pool.test.ts"],
  },
});
