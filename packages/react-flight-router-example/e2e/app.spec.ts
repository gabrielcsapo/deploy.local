import { test, expect } from "@playwright/test";

test.describe("Initial page load", () => {
  test("home page renders with server content", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");
    await expect(page.locator("text=Server rendered at")).toBeVisible();
    await expect(page.locator("text=This is a server component")).toBeVisible();
  });

  test("navigation links are present", async ({ page }) => {
    await page.goto("/");
    const nav = page.locator("nav").first();
    await expect(nav.getByRole("link", { name: "Home" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "About" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Dashboard" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Blog" })).toBeVisible();
  });

  test("home page has MessageBoard client component", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Server Action Demo")).toBeVisible();
    await expect(page.locator('input[name="text"]')).toBeVisible();
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
  });
});

test.describe("Client-side navigation", () => {
  test("navigate to About page", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("text=Server rendered at")).toBeVisible();
    await expect(page.locator("text=mixing server and client components")).toBeVisible();
  });

  test("navigate to Dashboard page", async ({ page }) => {
    await page.goto("/");
    await page.locator("nav").first().getByRole("link", { name: "Dashboard" }).click();
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await expect(page.locator("h2")).toHaveText("Dashboard Overview");
    await expect(page.locator("text=nested route inside the dashboard layout")).toBeVisible();
  });

  test("navigate between dashboard sub-routes", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("h2")).toHaveText("Dashboard Overview");

    // Navigate to settings
    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.locator("h2").first()).toHaveText("Settings");
    await expect(page.locator("text=settings page within the dashboard")).toBeVisible();

    // Navigate back to overview
    await page.getByRole("link", { name: "Overview" }).click();
    await expect(page.locator("h2")).toHaveText("Dashboard Overview");
  });

  test("navigate Home -> About -> Home preserves route", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    await page.getByRole("link", { name: "Home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");
  });
});

test.describe("Client components", () => {
  test("Counter increments on About page", async ({ page }) => {
    await page.goto("/about");
    await expect(page.locator("text=Count: 0")).toBeVisible();

    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("text=Count: 1")).toBeVisible();

    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("text=Count: 2")).toBeVisible();
  });

  test("Counter works on Dashboard Settings page", async ({ page }) => {
    await page.goto("/dashboard/settings");
    await expect(page.locator("text=Count: 0")).toBeVisible();

    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("text=Count: 1")).toBeVisible();
  });
});

test.describe("Server actions", () => {
  test("submit a message via MessageBoard", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Server Action Demo")).toBeVisible();

    const msg = `PW-${Date.now()}-submit`;
    await page.fill('input[name="text"]', msg);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("h2", { hasText: "Messages" })).toBeVisible();
  });

  test("submit multiple messages", async ({ page }) => {
    await page.goto("/");

    const msg1 = `PW-${Date.now()}-first`;
    const msg2 = `PW-${Date.now()}-second`;

    await page.fill('input[name="text"]', msg1);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(msg1).first()).toBeVisible({ timeout: 10_000 });

    await page.fill('input[name="text"]', msg2);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText(msg2).first()).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("li", { hasText: msg1 })).toBeVisible();
    await expect(page.locator("li", { hasText: msg2 })).toBeVisible();
  });

  test("button shows pending state during submission", async ({ page }) => {
    await page.goto("/");
    const msg = `PW-${Date.now()}-pending`;
    await page.fill('input[name="text"]', msg);

    const submitButton = page.getByRole("button", { name: /Send|Sending/ });
    await submitButton.click();

    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe("Direct URL access", () => {
  test("load /about directly", async ({ page }) => {
    await page.goto("/about");
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("load /dashboard directly", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await expect(page.locator("h2")).toHaveText("Dashboard Overview");
  });

  test("load /dashboard/settings directly", async ({ page }) => {
    await page.goto("/dashboard/settings");
    await expect(page.locator("h2").first()).toHaveText("Settings");
    await expect(page.locator("text=Count: 0")).toBeVisible();
  });
});

test.describe("RSC navigation uses fetch (no full page reload)", () => {
  test("client navigation fetches RSC payload", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    const rscRequest = page.waitForRequest((req) => req.url().includes("__rsc"));

    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    const req = await rscRequest;
    expect(req.url()).toContain("__rsc");
  });
});

test.describe("SSR (Server-Side Rendering)", () => {
  test("initial HTML contains rendered content before JS executes", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.locator("h1")).toHaveText("Home");
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.locator("text=Server rendered at")).toBeVisible();
  });

  test("SSR HTML has nav links as real anchor tags", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const homeLink = page.locator('nav a[href="/"]');
    await expect(homeLink).toHaveText("Home");
    const aboutLink = page.locator('nav a[href="/about"]');
    await expect(aboutLink).toHaveText("About");
  });

  test("SSR works for nested routes", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });

    await expect(page.locator("h1")).toHaveText("Dashboard");
    await expect(page.locator("h2").first()).toHaveText("Settings");
  });

  test("hydration makes client components interactive", async ({ page }) => {
    await page.goto("/about");
    await expect(page.locator("text=Count: 0")).toBeVisible();
    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("text=Count: 1")).toBeVisible();
  });

  test("Tailwind CSS is loaded in SSR", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    // CSS link tag should be present in the head
    const cssLink = page.locator('link[rel="stylesheet"][href*="styles"]');
    await expect(cssLink).toHaveCount(1);
  });
});

test.describe("Segment diffing", () => {
  test("navigation sends X-RSC-Previous-URL header", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    const rscRequest = page.waitForRequest((req) => req.url().includes("__rsc"));

    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    const req = await rscRequest;
    const prevUrlHeader = req.headers()["x-rsc-previous-url"];
    expect(prevUrlHeader).toBe("/");
  });

  test("shared layout is preserved during sibling navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("nav").first()).toBeVisible();

    await page.locator("nav").first().getByRole("link", { name: "Dashboard" }).click();
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await expect(page.locator("nav").first()).toBeVisible();
  });

  test("dashboard sub-route navigation preserves dashboard layout", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("h2")).toHaveText("Dashboard Overview");

    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.locator("h2").first()).toHaveText("Settings");
    await expect(page.locator("h1")).toHaveText("Dashboard");
  });
});

// ============================================
// New dynamic route tests
// ============================================

test.describe("Blog posts - server-side data fetching", () => {
  test("posts list page fetches and renders posts", async ({ page }) => {
    await page.goto("/posts");
    await expect(page.locator("h1")).toHaveText("Blog");
    await expect(page.locator("h2").first()).toHaveText("Recent Posts");
    // JSONPlaceholder returns data - post cards should be visible
    await expect(page.locator("ul li").first()).toBeVisible();
    await expect(page.locator("text=Fetched")).toBeVisible();
  });

  test("posts list has links to post detail pages", async ({ page }) => {
    await page.goto("/posts");
    const firstPostLink = page.locator('a[href="/posts/1"]');
    await expect(firstPostLink).toBeVisible();
  });

  test("posts list has links to user profiles", async ({ page }) => {
    await page.goto("/posts");
    const authorLink = page.locator('a[href^="/users/"]').first();
    await expect(authorLink).toBeVisible();
  });
});

test.describe("Blog post detail - dynamic route params", () => {
  test("post detail page renders post content", async ({ page }) => {
    await page.goto("/posts/1");
    await expect(page.locator("h1")).toHaveText("Blog");
    // Post title should be visible
    await expect(page.locator("article h2")).toBeVisible();
    // Comments section
    await expect(page.locator("h3", { hasText: "Comments" })).toBeVisible();
  });

  test("navigating from posts list to detail preserves layout", async ({ page }) => {
    await page.goto("/posts");
    await expect(page.locator("h1")).toHaveText("Blog");

    await page.locator('a[href="/posts/1"]').first().click();
    // Blog layout should persist
    await expect(page.locator("h1")).toHaveText("Blog");
    await expect(page.locator("article h2")).toBeVisible();
  });

  test("different post IDs render different content", async ({ page }) => {
    await page.goto("/posts/1");
    const firstTitle = await page.locator("article h2").textContent();

    await page.goto("/posts/2");
    const secondTitle = await page.locator("article h2").textContent();

    expect(firstTitle).not.toBe(secondTitle);
  });

  test("post detail has like button (client component)", async ({ page }) => {
    await page.goto("/posts/1");
    const likeButton = page.getByRole("button", { name: /Like/ });
    await expect(likeButton).toBeVisible();

    await likeButton.click();
    await expect(page.getByRole("button", { name: /Liked/ })).toBeVisible();

    await page.getByRole("button", { name: /Liked/ }).click();
    await expect(page.getByRole("button", { name: /^Like/ })).toBeVisible();
  });

  test("post detail has comment form (server action)", async ({ page }) => {
    await page.goto("/posts/1");
    await expect(page.locator("text=Add a Comment")).toBeVisible();

    const commentName = `Test-${Date.now()}`;
    const commentBody = `E2E comment ${Date.now()}`;
    await page.fill('input[name="name"]', commentName);
    await page.fill('input[name="body"]', commentBody);
    await page.getByRole("button", { name: "Post Comment" }).click();

    await expect(page.getByText(commentBody).first()).toBeVisible({ timeout: 10_000 });
  });

  test("post detail links to user profile", async ({ page }) => {
    await page.goto("/posts/1");
    const authorLink = page.locator('a[href^="/users/"]');
    await expect(authorLink).toBeVisible();
  });
});

test.describe("User profiles - nested data fetching", () => {
  test("user profile page renders user info", async ({ page }) => {
    await page.goto("/users/1");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("text=Email:")).toBeVisible();
    await expect(page.locator("text=Phone:")).toBeVisible();
    await expect(page.locator("text=Company:")).toBeVisible();
  });

  test("user profile shows their posts", async ({ page }) => {
    await page.goto("/users/1");
    await expect(page.locator("h2", { hasText: "Posts by" })).toBeVisible();
    // User's posts should have at least one card
    await expect(page.locator("ul li").first()).toBeVisible();
  });

  test("user profile post links navigate to post detail", async ({ page }) => {
    await page.goto("/users/1");
    const postLink = page.locator('a[href^="/posts/"]').first();
    await expect(postLink).toBeVisible();
    await postLink.click();
    await expect(page.locator("article h2")).toBeVisible();
  });

  test("navigate from post to author profile", async ({ page }) => {
    await page.goto("/posts/1");
    const authorLink = page.locator('a[href^="/users/"]').first();
    await authorLink.click();
    await expect(page.locator("h2", { hasText: "Posts by" })).toBeVisible();
  });
});

test.describe("Dynamic routes - direct URL access", () => {
  test("load /posts directly", async ({ page }) => {
    await page.goto("/posts");
    await expect(page.locator("h1")).toHaveText("Blog");
    await expect(page.locator("nav").first()).toBeVisible();
  });

  test("load /posts/1 directly", async ({ page }) => {
    await page.goto("/posts/1");
    await expect(page.locator("h1")).toHaveText("Blog");
    await expect(page.locator("article h2")).toBeVisible();
  });

  test("load /users/1 directly", async ({ page }) => {
    await page.goto("/users/1");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("text=Email:")).toBeVisible();
  });
});

test.describe("Dynamic routes - SSR", () => {
  test("posts list is SSR rendered", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/posts", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveText("Blog");
    await expect(page.locator("ul li").first()).toBeVisible();
  });

  test("post detail is SSR rendered", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/posts/1", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveText("Blog");
    await expect(page.locator("article h2")).toBeVisible();
  });

  test("user profile is SSR rendered", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/users/1", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("text=Email:")).toBeVisible();
  });
});

test.describe("Dynamic routes - segment diffing", () => {
  test("posts layout preserved during list-to-detail navigation", async ({ page }) => {
    await page.goto("/posts");
    await expect(page.locator("h1")).toHaveText("Blog");

    const rscRequest = page.waitForRequest((req) => req.url().includes("__rsc"));

    await page.locator('a[href="/posts/1"]').first().click();
    await expect(page.locator("article h2")).toBeVisible();

    const req = await rscRequest;
    const prevUrlHeader = req.headers()["x-rsc-previous-url"];
    expect(prevUrlHeader).toBe("/posts");
  });
});

// ============================================
// Deep nesting stress test (15 levels)
// ============================================

const FULL_DEPTH_URL =
  "/explore/alpha-centauri/spiral-a/sol/earth/europe/france/provence/marseille/vieux-port/rue-republique/hotel-dieu/1/suite-royale";

const EXPLORE_ROUTE_IDS = [
  "explore",
  "explore-universe",
  "explore-galaxy",
  "explore-system",
  "explore-planet",
  "explore-continent",
  "explore-country",
  "explore-region",
  "explore-city",
  "explore-district",
  "explore-street",
  "explore-building",
  "explore-floor",
  "explore-room",
];

async function getAllTimestamps(page: import("@playwright/test").Page) {
  const timestamps: Record<string, string> = {};
  for (const id of EXPLORE_ROUTE_IDS) {
    const el = page.getByTestId(`timestamp-${id}`);
    if ((await el.count()) > 0) {
      timestamps[id] = (await el.textContent()) ?? "";
    }
  }
  return timestamps;
}

test.describe("Deep nesting stress test", () => {
  test("renders all 15 levels at full depth URL", async ({ page }) => {
    await page.goto(FULL_DEPTH_URL);

    for (const id of EXPLORE_ROUTE_IDS) {
      await expect(page.getByTestId(`level-${id}`)).toBeVisible();
      await expect(page.getByTestId(`timestamp-${id}`)).toBeVisible();
    }
  });

  test("leaf-only diffing: sibling room navigation preserves all parent timestamps", async ({
    page,
  }) => {
    await page.goto(FULL_DEPTH_URL);
    await expect(page.getByTestId("level-explore-room")).toBeVisible();

    const before = await getAllTimestamps(page);

    // Click sibling link at room level (navigate to chambre-bleue)
    await page.getByTestId("sibling-explore-room").first().click();
    await expect(page.getByTestId("level-explore-room")).toContainText("chambre-bleue");

    const after = await getAllTimestamps(page);

    // All levels except room should have unchanged timestamps
    for (const id of EXPLORE_ROUTE_IDS) {
      if (id === "explore-room") {
        expect(after[id]).not.toBe(before[id]);
      } else {
        expect(after[id]).toBe(before[id]);
      }
    }
  });

  test("mid-level diffing: changing city re-renders city through room", async ({ page }) => {
    await page.goto(FULL_DEPTH_URL);
    await expect(page.getByTestId("level-explore-room")).toBeVisible();

    const before = await getAllTimestamps(page);

    // Click sibling link at city level
    await page.getByTestId("sibling-explore-city").first().click();
    await expect(page.getByTestId("level-explore-city")).toContainText("paris");

    const after = await getAllTimestamps(page);

    // Levels 0-7 (explore through region) should be unchanged
    const unchangedIds = EXPLORE_ROUTE_IDS.slice(0, 8);
    for (const id of unchangedIds) {
      expect(after[id]).toBe(before[id]);
    }

    // Levels 8-13 (city through room) should have changed
    const changedIds = EXPLORE_ROUTE_IDS.slice(8);
    for (const id of changedIds) {
      expect(after[id]).not.toBe(before[id]);
    }
  });

  test("near-top diffing: changing universe re-renders almost everything", async ({ page }) => {
    await page.goto(FULL_DEPTH_URL);
    await expect(page.getByTestId("level-explore-room")).toBeVisible();

    const before = await getAllTimestamps(page);

    // Click sibling link at universe level
    await page.getByTestId("sibling-explore-universe").first().click();
    await expect(page.getByTestId("level-explore-universe")).toContainText("milky-way");

    const after = await getAllTimestamps(page);

    // Only explore shell (level 0) should be unchanged
    expect(after["explore"]).toBe(before["explore"]);

    // All other levels should have changed
    for (const id of EXPLORE_ROUTE_IDS.slice(1)) {
      expect(after[id]).not.toBe(before[id]);
    }
  });

  test("cross-branch navigation from deep explore to /about", async ({ page }) => {
    await page.goto(FULL_DEPTH_URL);
    await expect(page.getByTestId("level-explore-room")).toBeVisible();

    await page.getByTestId("cross-branch-about").click();
    await expect(page.locator("h1")).toHaveText("About");

    // Explore levels should no longer be visible
    for (const id of EXPLORE_ROUTE_IDS) {
      await expect(page.getByTestId(`level-${id}`)).not.toBeVisible();
    }
  });

  test("SSR renders all 15 levels without JavaScript", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto(FULL_DEPTH_URL, { waitUntil: "domcontentloaded" });

    for (const id of EXPLORE_ROUTE_IDS) {
      await expect(page.getByTestId(`level-${id}`)).toBeVisible();
    }
  });

  test("navigate from explore index to full depth via client navigation", async ({ page }) => {
    await page.goto("/explore");
    await expect(page.getByText("Deep Nesting Stress Test")).toBeVisible();

    await page.getByTestId("dive-to-max-depth").click();

    for (const id of EXPLORE_ROUTE_IDS) {
      await expect(page.getByTestId(`level-${id}`)).toBeVisible();
    }
  });

  test("RSC request sends correct previous URL during deep navigation", async ({ page }) => {
    await page.goto(FULL_DEPTH_URL);
    await expect(page.getByTestId("level-explore-room")).toBeVisible();

    const rscRequest = page.waitForRequest((req) => req.url().includes("__rsc"));

    await page.getByTestId("sibling-explore-room").first().click();

    const req = await rscRequest;
    const prevUrlHeader = req.headers()["x-rsc-previous-url"];
    expect(prevUrlHeader).toBe(FULL_DEPTH_URL);
  });
});

// ============================================
// Active Link Styling
// ============================================

test.describe("Active link styling", () => {
  test("home link has active state on home page", async ({ page }) => {
    await page.goto("/");

    const homeLink = page.locator('nav a[href="/"]');
    await expect(homeLink).toHaveAttribute("aria-current", "page");
    await expect(homeLink).toHaveClass(/text-blue-600/);
    await expect(homeLink).toHaveClass(/font-semibold/);

    // Other links should not be active
    const aboutLink = page.locator('nav a[href="/about"]');
    await expect(aboutLink).not.toHaveAttribute("aria-current", "page");
    await expect(aboutLink).toHaveClass(/text-gray-700/);
  });

  test("active state updates after navigation", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    const aboutLink = page.locator('nav a[href="/about"]');
    await expect(aboutLink).toHaveAttribute("aria-current", "page");
    await expect(aboutLink).toHaveClass(/text-blue-600/);

    // Home should no longer be active
    const homeLink = page.locator('nav a[href="/"]');
    await expect(homeLink).not.toHaveAttribute("aria-current", "page");
  });

  test("prefix matching with end={false} keeps parent active", async ({ page }) => {
    await page.goto("/dashboard/settings");

    // Dashboard main nav link (end=false) should be active on sub-routes
    const dashLink = page.locator("nav").first().locator('a[href="/dashboard"]');
    await expect(dashLink).toHaveAttribute("aria-current", "page");
    await expect(dashLink).toHaveClass(/text-blue-600/);
  });

  test("dashboard sub-nav shows active state", async ({ page }) => {
    await page.goto("/dashboard");

    // Overview link should be active on /dashboard
    const overviewLink = page.locator('main a[href="/dashboard"]');
    await expect(overviewLink).toHaveClass(/text-blue-600/);

    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.locator("h2").first()).toHaveText("Settings");

    // Settings link should now be active
    const settingsLink = page.locator('main a[href="/dashboard/settings"]');
    await expect(settingsLink).toHaveClass(/text-blue-600/);
  });

  test("active link SSR renders correct link structure", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/about", { waitUntil: "domcontentloaded" });

    // In production SSR, links render as proper anchor tags even without JS
    const aboutLink = page.locator('nav a[href="/about"]');
    await expect(aboutLink).toBeVisible();
    await expect(aboutLink).toHaveText("About");
  });
});

// ============================================
// useSearchParams
// ============================================

test.describe("useSearchParams", () => {
  test("reads initial search params from URL", async ({ page }) => {
    await page.goto("/about?sort=oldest&q=test");

    await expect(page.getByTestId("current-sort")).toHaveText("Sort: oldest");
    await expect(page.getByTestId("current-query")).toHaveText("Query: test");
  });

  test("setSearchParams updates URL and re-renders", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByTestId("current-sort")).toHaveText("Sort: newest");

    await page.getByTestId("sort-oldest").click();
    await expect(page.getByTestId("current-sort")).toHaveText("Sort: oldest");
    await expect(page).toHaveURL(/sort=oldest/);
  });

  test("setSearchParams with function updater", async ({ page }) => {
    await page.goto("/about");
    await page.getByTestId("set-query").click();
    await expect(page.getByTestId("current-query")).toHaveText("Query: hello");
    await expect(page).toHaveURL(/q=hello/);
  });

  test("clearing search params removes them from URL", async ({ page }) => {
    await page.goto("/about?sort=oldest&q=test");

    await page.getByTestId("clear-params").click();
    await expect(page.getByTestId("current-sort")).toHaveText("Sort: newest");
    await expect(page.getByTestId("current-query")).toHaveText("Query: none");
    await expect(page).toHaveURL("/about");
  });
});

// ============================================
// Scroll Restoration
// ============================================

test.describe("Scroll restoration", () => {
  test("navigating to a new page scrolls to top", async ({ page }) => {
    await page.goto("/posts");

    // Scroll down
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(200);

    // Navigate to another page
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    // Should be scrolled to top
    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBe(0);
  });

  test("back navigation restores scroll position", async ({ page }) => {
    // Use a small viewport so the page is guaranteed to be scrollable
    await page.setViewportSize({ width: 1280, height: 300 });

    await page.goto("/posts");

    // Wait for hydration so ScrollRestoration is mounted
    await page.waitForLoadState("networkidle");

    // Ensure page is tall enough to scroll
    await page.evaluate(() => {
      document.documentElement.style.minHeight = "3000px";
    });

    // Scroll down and verify it actually took effect
    await page.evaluate(() => window.scrollTo(0, 400));
    await page.waitForFunction(() => window.scrollY >= 390, { timeout: 2000 });

    // Wait for the debounced save (100ms timeout + buffer)
    await page.waitForTimeout(300);

    // Navigate forward to About
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    // Go back
    await page.goBack();
    await expect(page.locator("h1").first()).toHaveText("Blog");

    // Ensure page is tall enough after re-render for scroll restoration
    await page.evaluate(() => {
      document.documentElement.style.minHeight = "3000px";
    });

    // Poll for scroll position to be restored (rAF + React re-render timing)
    await page.waitForFunction(() => window.scrollY > 300, { timeout: 5000 });

    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBeGreaterThanOrEqual(350);
    expect(scrollY).toBeLessThanOrEqual(450);
  });
});

// ============================================
// 404 Not Found
// ============================================

test.describe("Not Found handling", () => {
  test("unknown URL renders root not-found page", async ({ page }) => {
    await page.goto("/nonexistent-page");
    await expect(page.locator("h1")).toHaveText("404");
    await expect(page.locator("text=Page Not Found")).toBeVisible();
    // Root layout nav should still be visible
    await expect(page.locator("nav")).toBeVisible();
  });

  test("nested not-found renders within parent layout", async ({ page }) => {
    await page.goto("/dashboard/nonexistent");
    await expect(page.locator("text=Dashboard Page Not Found")).toBeVisible();
    // Dashboard layout should still be visible
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await expect(page.locator("nav").first()).toBeVisible();
  });

  test("not-found page has link back", async ({ page }) => {
    await page.goto("/nonexistent-page");
    await expect(page.locator("text=Go home")).toBeVisible();

    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");
  });

  test("not-found returns 404 HTTP status", async ({ page }) => {
    const response = await page.goto("/nonexistent-page");
    expect(response?.status()).toBe(404);
  });

  test("nested not-found returns 404 HTTP status", async ({ page }) => {
    const response = await page.goto("/dashboard/nonexistent");
    expect(response?.status()).toBe(404);
  });

  test("not-found SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/nonexistent-page", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveText("404");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("navigating from not-found page back to valid route works", async ({ page }) => {
    await page.goto("/nonexistent-page");
    await expect(page.locator("h1")).toHaveText("404");

    // Click "Go home" link to navigate back to a valid page
    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");

    // Should be on the home page with normal nav
    await expect(page.locator("nav").first()).toBeVisible();
  });
});
