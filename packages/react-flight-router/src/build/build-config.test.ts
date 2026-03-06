import { describe, it, expect } from "vitest";
import { createRSCServerConfig } from "./vite-config-rsc.js";
import { createSSRConfig } from "./vite-config-ssr.js";

describe("build config: minification", () => {
  it("RSC build config has minify enabled", () => {
    const { config } = createRSCServerConfig({
      appDir: "/tmp/app",
      outDir: "/tmp/out",
      routesEntry: "/tmp/app/routes.ts",
    });
    expect(config.build?.minify).toBe(true);
  });

  it("SSR build config has minify enabled", () => {
    const config = createSSRConfig({
      appDir: "/tmp/app",
      outDir: "/tmp/out",
      clientModules: new Set(["/tmp/app/client.tsx"]),
    });
    expect(config.build?.minify).toBe(true);
  });
});
