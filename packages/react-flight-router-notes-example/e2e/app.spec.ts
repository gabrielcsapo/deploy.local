import { test, expect } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

const SEED_DATA = [
  {
    id: "1",
    title: "Welcome to Flight Router",
    body: "This is a notes app built with React Server Components. The data you're reading was loaded from a JSON file on the server.",
    createdAt: "2025-01-01T00:00:00.000Z",
  },
  {
    id: "2",
    title: "Server Components",
    body: "Route components in Flight Router are server components by default. They can read files, query databases, and call APIs directly — no useEffect needed.",
    createdAt: "2025-01-02T00:00:00.000Z",
  },
  {
    id: "3",
    title: "Server Actions",
    body: "Use the 'use server' directive to define functions that run on the server. They handle form submissions and data mutations from client components.",
    createdAt: "2025-01-03T00:00:00.000Z",
  },
];

const NOTES_PATH = resolve(import.meta.dirname, "..", "data", "notes.json");

// Reset seed data before each test to ensure isolation
test.beforeEach(() => {
  writeFileSync(NOTES_PATH, JSON.stringify(SEED_DATA, null, 2), "utf-8");
});

// Restore seed data after all tests
test.afterAll(() => {
  writeFileSync(NOTES_PATH, JSON.stringify(SEED_DATA, null, 2), "utf-8");
});

test.describe("Initial page load", () => {
  test("home page renders with seed notes", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Notes");
    await expect(page.getByText("Server rendered at")).toBeVisible();
    await expect(page.getByText("3 notes")).toBeVisible();
  });

  test("seed note titles are listed", async ({ page }) => {
    await page.goto("/");
    // Use h2 locators for note titles to avoid matching body text
    await expect(page.locator("h2", { hasText: "Welcome to Flight Router" })).toBeVisible();
    await expect(page.locator("h2", { hasText: "Server Components" })).toBeVisible();
    await expect(page.locator("h2", { hasText: "Server Actions" })).toBeVisible();
  });

  test("navigation links are present", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav");
    await expect(nav.getByRole("link", { name: "Notes" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "New Note" })).toBeVisible();
  });
});

test.describe("Client-side navigation", () => {
  test("navigate to New Note page", async ({ page }) => {
    await page.goto("/");
    await page.locator('a[href="/notes/new"]').click();
    await page.waitForURL("**/notes/new");
    await expect(page.locator("h1")).toHaveText("New Note", { timeout: 10_000 });
  });

  test("navigate to a note detail", async ({ page }) => {
    await page.goto("/");
    await page.locator("h2", { hasText: "Welcome to Flight Router" }).click();
    await page.waitForURL("**/notes/1");
    await expect(page.locator("article h1")).toHaveText("Welcome to Flight Router");
    await expect(page.getByText("Back to notes")).toBeVisible();
  });

  test("navigate Home → New Note → Home", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Notes");

    await page.locator('a[href="/notes/new"]').click();
    await page.waitForURL("**/notes/new");
    await expect(page.locator("h1")).toHaveText("New Note", { timeout: 10_000 });

    await page.locator('nav a[href="/"]').click();
    await page.waitForURL(/\/$/);
    await expect(page.locator("h1")).toHaveText("Notes", { timeout: 10_000 });
  });

  test("navigate Home → Detail → Home", async ({ page }) => {
    await page.goto("/");
    await page.locator("h2", { hasText: "Welcome to Flight Router" }).click();
    await page.waitForURL("**/notes/1");
    await expect(page.locator("article h1")).toHaveText("Welcome to Flight Router");

    await page.getByText("← Back to notes").click();
    await page.waitForURL(/\/$/);
    await expect(page.locator("h1")).toHaveText("Notes", { timeout: 10_000 });
  });
});

test.describe("Server actions — create note", () => {
  test("create a note via form submission", async ({ page }) => {
    await page.goto("/notes/new");
    await expect(page.locator("h1")).toHaveText("New Note");

    await page.fill('input[name="title"]', "Test Note");
    await page.fill('textarea[name="body"]', "Created by Playwright e2e test.");
    await page.getByRole("button", { name: "Create Note" }).click();

    await expect(page.getByText("Note created successfully!")).toBeVisible({ timeout: 10_000 });
  });

  test("created note appears on home page", async ({ page }) => {
    await page.goto("/notes/new");
    await page.fill('input[name="title"]', "Persistence Test");
    await page.fill('textarea[name="body"]', "Verifying the note persists to disk.");
    await page.getByRole("button", { name: "Create Note" }).click();
    await expect(page.getByText("Note created successfully!")).toBeVisible({ timeout: 10_000 });

    await page.goto("/");
    await expect(page.getByText("Persistence Test")).toBeVisible();
    await expect(page.getByText("4 notes")).toBeVisible();
  });

  test("shows validation error when title is empty", async ({ page }) => {
    await page.goto("/notes/new");
    await page.fill('textarea[name="body"]', "Some body text");
    await page.getByRole("button", { name: "Create Note" }).click();
    await expect(page.getByText("Title is required")).toBeVisible({ timeout: 10_000 });
  });

  test("shows validation error when body is empty", async ({ page }) => {
    await page.goto("/notes/new");
    await page.fill('input[name="title"]', "Title Only");
    await page.getByRole("button", { name: "Create Note" }).click();
    await expect(page.getByText("Body is required")).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Server actions — delete note", () => {
  test("delete a note and verify it is gone", async ({ page }) => {
    // Navigate to a seed note directly
    await page.goto("/notes/1");
    await expect(page.locator("article h1")).toHaveText("Welcome to Flight Router");

    // Delete it
    await page.getByRole("button", { name: "Delete Note" }).click();
    await expect(page.getByText("Note deleted")).toBeVisible({ timeout: 10_000 });

    // Verify it's gone from the home page
    await page.goto("/");
    await expect(page.locator("h2", { hasText: "Welcome to Flight Router" })).not.toBeVisible();
    await expect(page.getByText("2 notes")).toBeVisible();
  });
});

test.describe("Direct URL access", () => {
  test("load / directly", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Notes");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("load /notes/new directly", async ({ page }) => {
    await page.goto("/notes/new");
    await expect(page.locator("h1")).toHaveText("New Note");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("load /notes/1 directly", async ({ page }) => {
    await page.goto("/notes/1");
    await expect(page.locator("article h1")).toHaveText("Welcome to Flight Router");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("load nonexistent note shows not found", async ({ page }) => {
    await page.goto("/notes/nonexistent");
    await expect(page.getByText("Note not found")).toBeVisible();
  });
});

test.describe("RSC navigation", () => {
  test("client navigation fetches RSC payload", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Notes");

    const rscRequest = page.waitForRequest((req) => req.url().includes("__rsc"));
    await page.locator("h2", { hasText: "Welcome to Flight Router" }).click();
    await page.waitForURL("**/notes/1");
    await expect(page.locator("article h1")).toHaveText("Welcome to Flight Router", {
      timeout: 10_000,
    });

    const req = await rscRequest;
    expect(req.url()).toContain("__rsc");
  });
});

test.describe("SSR", () => {
  test("home page renders without JavaScript", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.locator("h1")).toHaveText("Notes");
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.getByText("Server rendered at")).toBeVisible();
  });

  test("nav links are real anchor tags", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.locator('nav a[href="/"]')).toHaveText("Notes");
    await expect(page.locator('nav a[href="/notes/new"]')).toHaveText("New Note");
  });

  test("new note page renders without JavaScript", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/notes/new", { waitUntil: "domcontentloaded" });

    await expect(page.locator("h1")).toHaveText("New Note");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("note detail renders without JavaScript", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/notes/1", { waitUntil: "domcontentloaded" });

    await expect(page.locator("article h1")).toHaveText("Welcome to Flight Router");
  });

  test("CSS stylesheet is loaded", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const cssLink = page.locator('link[rel="stylesheet"]');
    await expect(cssLink.first()).toBeAttached();
  });
});
