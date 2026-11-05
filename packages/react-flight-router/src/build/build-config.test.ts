import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRSCServerConfig } from "./vite-config-rsc.js";
import { createSSRConfig } from "./vite-config-ssr.js";
import { detectNativeModules } from "./build-orchestrator.js";

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

describe("native dependency detection", () => {
  it("externalizes packages that ship binding.gyp even when gypfile is false", () => {
    const appRoot = mkdtempSync(join(tmpdir(), "rfr-native-module-"));
    const nativeDir = join(appRoot, "node_modules", "native-addon");
    const plainDir = join(appRoot, "node_modules", "plain-package");

    try {
      mkdirSync(nativeDir, { recursive: true });
      mkdirSync(plainDir, { recursive: true });
      writeFileSync(
        join(appRoot, "package.json"),
        JSON.stringify({
          dependencies: {
            "native-addon": "1.0.0",
            "plain-package": "1.0.0",
          },
        }),
      );
      writeFileSync(
        join(nativeDir, "package.json"),
        JSON.stringify({ name: "native-addon", version: "1.0.0", gypfile: false }),
      );
      writeFileSync(join(nativeDir, "binding.gyp"), "{}");
      writeFileSync(
        join(plainDir, "package.json"),
        JSON.stringify({ name: "plain-package", version: "1.0.0" }),
      );

      expect(detectNativeModules(appRoot)).toEqual(["native-addon"]);
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });
});
