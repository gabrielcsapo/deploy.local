import { test, expect } from "@playwright/test";

// ===========================================
// Dev SSR - HTML rendered without JavaScript
// ===========================================

test.describe("Dev SSR", () => {
  test("home page SSR renders content without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.locator("h1")).toHaveText("Home");
    await expect(page.locator("nav")).toBeVisible();
    await expect(page.locator("text=Server rendered at")).toBeVisible();
  });

  test("about page SSR renders server and client components", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/about", { waitUntil: "domcontentloaded" });

    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("text=Server rendered at")).toBeVisible();
    await expect(page.locator("text=Count: 0")).toBeVisible();
  });

  test("nested routes SSR render correctly", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/dashboard/settings", { waitUntil: "domcontentloaded" });

    await expect(page.locator("h1")).toHaveText("Dashboard");
    await expect(page.locator("h2").first()).toHaveText("Settings");
  });

  test("SSR HTML has nav links as real anchor tags", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    await expect(page.locator('nav a[href="/"]')).toHaveText("Home");
    await expect(page.locator('nav a[href="/about"]')).toHaveText("About");
    await expect(page.locator('nav a[href="/dashboard"]')).toHaveText("Dashboard");
    await expect(page.locator('nav a[href="/posts"]')).toHaveText("Blog");
  });
});

// ===========================================
// Dev CSS
// ===========================================

test.describe("Dev CSS", () => {
  test("CSS link tag is present in SSR HTML", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/", { waitUntil: "domcontentloaded" });

    const cssLink = page.locator('link[rel="stylesheet"][href="/app/styles.css"]');
    await expect(cssLink).toHaveCount(1);
  });

  test("Tailwind styles are applied", async ({ page }) => {
    await page.goto("/");
    // nav has bg-gray-100 class — should have a visible background
    const nav = page.locator("nav").first();
    await expect(nav).toBeVisible();
    const bgColor = await nav.evaluate((el) => getComputedStyle(el).backgroundColor);
    // bg-gray-100 = rgb(243, 244, 246) — just verify it's not transparent
    expect(bgColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(bgColor).not.toBe("transparent");
  });
});

// ===========================================
// Hydration
// ===========================================

test.describe("Hydration", () => {
  test("counter on about page hydrates and increments", async ({ page }) => {
    await page.goto("/about");
    await expect(page.locator("text=Count: 0")).toBeVisible();

    // Wait for hydration — in dev mode, modules load individually so it takes longer
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("text=Count: 1")).toBeVisible();

    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("text=Count: 2")).toBeVisible();
  });

  test("counter on dashboard settings hydrates", async ({ page }) => {
    await page.goto("/dashboard/settings");
    await expect(page.locator("text=Count: 0")).toBeVisible();

    // Wait for hydration — in dev mode, modules load individually so it takes longer
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "Increment" }).click();
    await expect(page.locator("text=Count: 1")).toBeVisible();
  });
});

// ===========================================
// Client-side navigation
// ===========================================

test.describe("Client-side navigation", () => {
  test("navigate to About page via Link", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.locator("text=Server rendered at")).toBeVisible();
  });

  test("navigate to Dashboard page via Link", async ({ page }) => {
    await page.goto("/");
    await page.locator("nav").first().getByRole("link", { name: "Dashboard" }).click();
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await expect(page.locator("h2")).toHaveText("Dashboard Overview");
  });

  test("navigate between dashboard sub-routes", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("h2")).toHaveText("Dashboard Overview");

    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.locator("h2").first()).toHaveText("Settings");

    await page.getByRole("link", { name: "Overview" }).click();
    await expect(page.locator("h2")).toHaveText("Dashboard Overview");
  });

  test("RSC endpoint is fetched during navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    // Wait for hydration so Link click handlers are active
    await page.waitForLoadState("networkidle");

    const [req] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("__rsc")),
      page.getByRole("link", { name: "About" }).first().click(),
    ]);

    await expect(page.locator("h1")).toHaveText("About");
    expect(req.url()).toContain("__rsc");
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

// ===========================================
// Server actions
// ===========================================

test.describe("Server actions", () => {
  test("submit a message via MessageBoard", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Server Action Demo")).toBeVisible();

    const msg = `PW-DEV-${Date.now()}-submit`;
    await page.fill('input[name="text"]', msg);
    await page.getByRole("button", { name: "Send" }).click();

    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 10_000 });
  });
});

// ===========================================
// Direct URL access
// ===========================================

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

// ===========================================
// Dynamic routes
// ===========================================

test.describe("Dynamic routes", () => {
  test("posts list page renders", async ({ page }) => {
    await page.goto("/posts");
    await expect(page.locator("h1")).toHaveText("Blog");
    await expect(page.locator("h2").first()).toHaveText("Recent Posts");
    await expect(page.locator("ul li").first()).toBeVisible();
  });

  test("post detail page renders", async ({ page }) => {
    await page.goto("/posts/1");
    await expect(page.locator("h1")).toHaveText("Blog");
    await expect(page.locator("article h2")).toBeVisible();
    await expect(page.locator("h3", { hasText: "Comments" })).toBeVisible();
  });

  test("user profile page renders", async ({ page }) => {
    await page.goto("/users/1");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("text=Email:")).toBeVisible();
    await expect(page.locator("text=Phone:")).toBeVisible();
  });

  test("navigate from posts list to detail", async ({ page }) => {
    await page.goto("/posts");
    await expect(page.locator("h1")).toHaveText("Blog");

    await page.locator('a[href="/posts/1"]').first().click();
    await expect(page.locator("article h2")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Blog");
  });
});

// ===========================================
// Dynamic routes - SSR
// ===========================================

test.describe("Dynamic routes SSR", () => {
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

// ===========================================
// Deep nesting stress test (15 levels)
// ===========================================

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

test.describe("Deep nesting", () => {
  test("full depth renders all 15 levels in dev mode", async ({ page }) => {
    await page.goto(FULL_DEPTH_URL);

    for (const id of EXPLORE_ROUTE_IDS) {
      await expect(page.getByTestId(`level-${id}`)).toBeVisible();
      await expect(page.getByTestId(`timestamp-${id}`)).toBeVisible();
    }
  });

  test("leaf navigation works in dev mode", async ({ page }) => {
    await page.goto(FULL_DEPTH_URL);
    await expect(page.getByTestId("level-explore-room")).toBeVisible();

    await page.waitForLoadState("networkidle");

    await page.getByTestId("sibling-explore-room").first().click();
    await expect(page.getByTestId("level-explore-room")).toContainText("chambre-bleue");
  });
});

// ===========================================
// Active Link Styling
// ===========================================

test.describe("Active link styling", () => {
  test("home link has active state on home page", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

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
    await page.waitForLoadState("networkidle");

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
    await page.waitForLoadState("networkidle");

    // Dashboard main nav link (end=false) should be active on sub-routes
    const dashLink = page.locator("nav").first().locator('a[href="/dashboard"]');
    await expect(dashLink).toHaveAttribute("aria-current", "page");
    await expect(dashLink).toHaveClass(/text-blue-600/);
  });

  test("dashboard sub-nav shows active state", async ({ page }) => {
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");

    // Overview link should be active on /dashboard
    const overviewLink = page.locator('main a[href="/dashboard"]');
    await expect(overviewLink).toHaveClass(/text-blue-600/);

    await page.getByRole("link", { name: "Settings" }).first().click();
    await expect(page.locator("h2").first()).toHaveText("Settings");

    // Settings link should now be active
    const settingsLink = page.locator('main a[href="/dashboard/settings"]');
    await expect(settingsLink).toHaveClass(/text-blue-600/);
  });

  test("active link SSR renders aria-current", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/about", { waitUntil: "domcontentloaded" });

    const aboutLink = page.locator('nav a[href="/about"]');
    await expect(aboutLink).toHaveAttribute("aria-current", "page");
  });

  test("pending state shows during slow navigation", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const slowLink = page.locator('nav a[href="/slow"]');
    // Should not be active or pending initially
    await expect(slowLink).toHaveClass(/text-gray-700/);

    // Click the Slow link (3s server delay)
    await slowLink.click();

    // Should show pending state (animate-pulse) while loading
    await expect(slowLink).toHaveClass(/animate-pulse/, { timeout: 2000 });
    await expect(slowLink).toHaveClass(/text-blue-400/);

    // Wait for navigation to complete
    await expect(page.locator("h1")).toHaveText("Slow Page", { timeout: 10000 });

    // Should now be active, not pending
    await expect(slowLink).toHaveClass(/text-blue-600/);
    await expect(slowLink).toHaveClass(/font-semibold/);
    await expect(slowLink).toHaveAttribute("aria-current", "page");
  });
});

// ===========================================
// useSearchParams
// ===========================================

test.describe("useSearchParams", () => {
  test("reads initial search params from URL", async ({ page }) => {
    await page.goto("/about?sort=oldest&q=test");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("current-sort")).toHaveText("Sort: oldest");
    await expect(page.getByTestId("current-query")).toHaveText("Query: test");
  });

  test("setSearchParams updates URL and re-renders", async ({ page }) => {
    await page.goto("/about");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("current-sort")).toHaveText("Sort: newest");

    await page.getByTestId("sort-oldest").click();
    await expect(page.getByTestId("current-sort")).toHaveText("Sort: oldest");
    await expect(page).toHaveURL(/sort=oldest/);
  });

  test("setSearchParams with function updater", async ({ page }) => {
    await page.goto("/about");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("set-query").click();
    await expect(page.getByTestId("current-query")).toHaveText("Query: hello");
    await expect(page).toHaveURL(/q=hello/);
  });

  test("clearing search params removes them from URL", async ({ page }) => {
    await page.goto("/about?sort=oldest&q=test");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("clear-params").click();
    await expect(page.getByTestId("current-sort")).toHaveText("Sort: newest");
    await expect(page.getByTestId("current-query")).toHaveText("Query: none");
    await expect(page).toHaveURL("/about");
  });
});

// ===========================================
// Scroll Restoration
// ===========================================

test.describe("Scroll restoration", () => {
  test("navigating to a new page scrolls to top", async ({ page }) => {
    await page.goto("/posts");
    await page.waitForLoadState("networkidle");

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

// ===========================================
// 404 Not Found
// ===========================================

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
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Go home")).toBeVisible();

    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");
  });

  test("not-found SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/nonexistent-page", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveText("404");
    await expect(page.locator("nav")).toBeVisible();
  });
});
