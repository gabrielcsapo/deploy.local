import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const rootDir = resolve(import.meta.dirname, "../../..");
const exampleDir = resolve(rootDir, "packages/react-flight-router-example");
const docsContentDir = resolve(import.meta.dirname, "../content");
const targetFile = resolve(docsContentDir, "architecture/build-pipeline.md");

const START_MARKER = "<!-- BUILD_OUTPUT_START -->";
const END_MARKER = "<!-- BUILD_OUTPUT_END -->";

function captureBuildOutput(): string | null {
  try {
    // Build the library first
    console.log("Building react-flight-router library...");
    execSync("pnpm build:lib", { cwd: rootDir, stdio: "pipe" });

    // Run the example build and capture output (no color for clean text)
    console.log("Running example app build...");
    const output = execSync("npx react-flight-router build", {
      cwd: exampleDir,
      stdio: "pipe",
      env: { ...process.env, NO_COLOR: "1" },
    });

    return output.toString("utf-8").trim();
  } catch (err) {
    console.error("Failed to capture build output:", err instanceof Error ? err.message : err);
    return null;
  }
}

function injectIntoMarkdown(buildOutput: string): void {
  const md = readFileSync(targetFile, "utf-8");

  const startIdx = md.indexOf(START_MARKER);
  const endIdx = md.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error(
      `Markers not found in ${targetFile}. Add ${START_MARKER} and ${END_MARKER} markers.`,
    );
    process.exit(1);
  }

  const before = md.slice(0, startIdx + START_MARKER.length);
  const after = md.slice(endIdx);

  const updated = `${before}\n\`\`\`\n${buildOutput}\n\`\`\`\n${after}`;

  writeFileSync(targetFile, updated, "utf-8");
  console.log("Build output injected into build-pipeline.md");
}

const output = captureBuildOutput();
if (output) {
  injectIntoMarkdown(output);
} else {
  console.log("Skipping injection — using existing build output in docs.");
}
