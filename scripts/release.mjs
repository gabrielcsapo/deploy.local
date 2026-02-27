#!/usr/bin/env node

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const LIB_DIR = resolve(ROOT, "packages/react-flight-router");
const LIB_PKG_PATH = resolve(LIB_DIR, "package.json");
const CHANGELOG_PATH = resolve(ROOT, "CHANGELOG.md");
const GITHUB_REPO = "https://github.com/gabrielcsapo/flight-router";

// ─── Parse CLI arguments ──────────────────────────────────────
const args = process.argv.slice(2);
const bumpType = args.find((a) => ["patch", "minor", "major"].includes(a));
const dryRun = args.includes("--dry-run");
const noPush = args.includes("--no-push");

if (!bumpType) {
  console.error("Usage: node scripts/release.mjs <patch|minor|major> [--dry-run] [--no-push]");
  process.exit(1);
}

// ─── Helpers ──────────────────────────────────────────────────
function run(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", cwd: ROOT, stdio: "pipe", ...opts }).trim();
}

function bumpVersion(version, type) {
  const [major, minor, patch] = version.split(".").map(Number);
  switch (type) {
    case "major":
      return `${major + 1}.0.0`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
  }
}

function semverCompare(a, b) {
  const pa = a.replace(/^v/, "").split(".").map(Number);
  const pb = b.replace(/^v/, "").split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

// ─── Validate preconditions ───────────────────────────────────
const branch = run("git rev-parse --abbrev-ref HEAD");
if (branch !== "main") {
  console.error(`Error: Must be on 'main' branch (currently on '${branch}')`);
  process.exit(1);
}

const status = run("git status --porcelain");
if (status) {
  console.error("Error: Working directory is not clean. Commit or stash changes first.");
  console.error(status);
  process.exit(1);
}

try {
  run("git fetch origin main");
  const local = run("git rev-parse HEAD");
  const remote = run("git rev-parse origin/main");
  if (local !== remote) {
    console.error("Error: Local branch is not up to date with origin/main. Pull first.");
    process.exit(1);
  }
} catch {
  console.warn("Warning: Could not verify remote status. Continuing...");
}

if (!dryRun) {
  try {
    run("npm whoami");
  } catch {
    console.error("Error: Not authenticated with npm. Run 'npm login' first.");
    process.exit(1);
  }
}

// ─── Determine new version ────────────────────────────────────
const libPkg = JSON.parse(readFileSync(LIB_PKG_PATH, "utf-8"));
const currentVersion = libPkg.version;
const newVersion = bumpVersion(currentVersion, bumpType);
const tagName = `v${newVersion}`;

console.log(`\nReleasing react-flight-router: ${currentVersion} → ${newVersion}\n`);

const allTags = run("git tag -l")
  .split("\n")
  .filter((t) => /^v\d+\.\d+\.\d+$/.test(t));

if (allTags.includes(tagName)) {
  console.error(`Error: Tag '${tagName}' already exists.`);
  process.exit(1);
}

// ─── Generate changelog ───────────────────────────────────────
const lastTag = allTags.sort(semverCompare).pop();
const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
const raw = run(`git log ${range} --format="%H|||%s" --no-merges`);

if (!raw) {
  console.error("Error: No commits since last release.");
  process.exit(1);
}

const commits = raw
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [hash, ...rest] = line.split("|||");
    return { hash, subject: rest.join("|||") };
  });

const categories = {
  feat: { title: "Features", commits: [] },
  fix: { title: "Bug Fixes", commits: [] },
  bug: { title: "Bug Fixes", commits: [] },
  chore: { title: "Chores", commits: [] },
  docs: { title: "Documentation", commits: [] },
  refactor: { title: "Refactoring", commits: [] },
  perf: { title: "Performance", commits: [] },
  test: { title: "Tests", commits: [] },
  other: { title: "Other", commits: [] },
};

for (const commit of commits) {
  const match = commit.subject.match(/^(\w+):\s*(.+)/);
  if (match) {
    const type = match[1];
    const description = match[2];
    const target = categories[type] || categories.other;
    target.commits.push({ hash: commit.hash, description });
  } else {
    categories.other.commits.push({ hash: commit.hash, description: commit.subject });
  }
}

const dateStr = new Date().toISOString().split("T")[0];
const compareUrl = lastTag
  ? `${GITHUB_REPO}/compare/${lastTag}...${tagName}`
  : `${GITHUB_REPO}/releases/tag/${tagName}`;

let entry = `## [${newVersion}](${compareUrl}) (${dateStr})\n\n`;

// Deduplicate bug/fix into one section
const seen = new Set();
for (const [key, category] of Object.entries(categories)) {
  if (category.commits.length === 0) continue;
  if (key === "bug" && categories.fix.commits.length > 0) {
    // Merge bug commits into fix section (already shown)
    continue;
  }
  if (key === "fix") {
    // Combine fix + bug
    category.commits.push(...categories.bug.commits);
  }
  if (seen.has(category.title)) continue;
  seen.add(category.title);

  entry += `### ${category.title}\n\n`;
  for (const commit of category.commits) {
    const shortHash = commit.hash.substring(0, 7);
    entry += `- ${commit.description} ([${shortHash}](${GITHUB_REPO}/commit/${commit.hash}))\n`;
  }
  entry += "\n";
}

if (dryRun) {
  console.log("Changelog entry that would be generated:\n");
  console.log(entry);
}

// ─── Update CHANGELOG.md ─────────────────────────────────────
const header =
  "# Changelog\n\nAll notable changes to this project will be documented in this file.\n\n";
let existingContent = "";
if (existsSync(CHANGELOG_PATH)) {
  existingContent = readFileSync(CHANGELOG_PATH, "utf-8");
  existingContent = existingContent.replace(/^# Changelog\n\nAll notable changes[^\n]*\n\n/, "");
}

if (!dryRun) {
  writeFileSync(CHANGELOG_PATH, header + entry + existingContent);
  console.log("Updated CHANGELOG.md");
}

// ─── Update package.json version ──────────────────────────────
if (!dryRun) {
  libPkg.version = newVersion;
  writeFileSync(LIB_PKG_PATH, JSON.stringify(libPkg, null, "\t") + "\n");
  console.log(`Updated packages/react-flight-router/package.json to ${newVersion}`);
}

// ─── Format generated files ──────────────────────────────────
if (!dryRun) {
  console.log("\nFormatting files...");
  execSync("pnpm run fmt", { cwd: ROOT, stdio: "inherit" });
  console.log("Format complete.");
} else {
  console.log("[dry-run] Would run: pnpm run fmt");
}

// ─── Build the library ────────────────────────────────────────
if (!dryRun) {
  console.log("\nBuilding library...");
  execSync("pnpm build:lib", { cwd: ROOT, stdio: "inherit" });
  console.log("Build complete.");
} else {
  console.log("[dry-run] Would run: pnpm build:lib");
}

// ─── Git commit + tag ─────────────────────────────────────────
if (!dryRun) {
  run(`git add "${CHANGELOG_PATH}" "${LIB_PKG_PATH}"`);
  run(`git commit -m "release: v${newVersion}"`);
  run(`git tag -a ${tagName} -m "v${newVersion}"`);
  console.log(`Created commit and tag: ${tagName}`);
} else {
  console.log(`[dry-run] Would commit and tag: ${tagName}`);
}

// ─── Publish to npm ───────────────────────────────────────────
if (!dryRun) {
  console.log("\nPublishing to npm...");
  execSync("pnpm publish --no-git-checks --access public", { cwd: LIB_DIR, stdio: "inherit" });
  console.log(`Published react-flight-router@${newVersion}`);
} else {
  console.log(`[dry-run] Would publish react-flight-router@${newVersion}`);
}

// ─── Git push ─────────────────────────────────────────────────
if (!dryRun && !noPush) {
  run("git push origin main --follow-tags");
  console.log("Pushed to origin/main with tags");
} else if (!dryRun && noPush) {
  console.log("\nSkipping push (--no-push). Run manually:");
  console.log("  git push origin main --follow-tags");
}

console.log(`\nDone! Released react-flight-router@${newVersion}`);
