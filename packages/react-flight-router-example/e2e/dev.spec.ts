import { test, expect } from "@playwright/test";
import http from "http";

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
    // The bg-gray-100 class is on the nav wrapper div, not the <nav> itself.
    // Target the wrapper div that contains the nav.
    const navWrapper = page.locator("nav").first().locator("..");
    await expect(navWrapper).toBeVisible();
    // In dev mode, Vite loads CSS asynchronously. Poll until bg-color is applied.
    await page.waitForFunction(
      () => {
        const nav = document.querySelector("nav");
        if (!nav?.parentElement) return false;
        const bg = getComputedStyle(nav.parentElement).backgroundColor;
        return bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent";
      },
      { timeout: 15_000 },
    );
    const bgColor = await navWrapper.evaluate((el) => getComputedStyle(el).backgroundColor);
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

// ===========================================
// 500 Error Route
// ===========================================

test.describe("Error route handling", () => {
  test("broken route renders error page", async ({ page }) => {
    await page.goto("/broken");
    await expect(page.locator("h1")).toHaveText("500");
    await expect(page.locator("text=Something Went Wrong")).toBeVisible();
    await expect(page.locator("nav")).toBeVisible();
  });

  test("error page shows error message", async ({ page }) => {
    await page.goto("/broken");
    await expect(page.locator("text=This route is intentionally broken")).toBeVisible();
  });

  test("error page has link back", async ({ page }) => {
    await page.goto("/broken");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Go home")).toBeVisible();

    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");
  });

  test("error SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/broken", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveText("500");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("client-side navigation from dashboard to broken shows error page", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("h1")).toHaveText("Dashboard");
    await page.waitForLoadState("networkidle");

    await page.locator("nav").first().getByRole("link", { name: "Broken" }).click();
    await expect(page.locator("h1")).toHaveText("500");
    await expect(page.locator("text=Something Went Wrong")).toBeVisible();
    // Root layout nav should still be visible
    await expect(page.locator("nav")).toBeVisible();
  });

  test("error page CSS from server component import is applied", async ({ page }) => {
    await page.goto("/broken");
    const errorContent = page.getByTestId("error-content");
    await expect(errorContent).toBeVisible();
    // error.css sets border-left: 4px solid #f87171 on .error-page
    const borderLeft = await errorContent.evaluate((el) => getComputedStyle(el).borderLeftStyle);
    expect(borderLeft).toBe("solid");
  });
});

// ===========================================
// Tabs - Server component routes with similar name prefixes
// ===========================================
// Regression test for manifest collision where "tabs" and "tabs-index"
// route IDs collide due to substring matching.

test.describe("Tabs - layout/index prefix collision", () => {
  test("tabs layout renders with index content", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Tabs");
    await expect(page.getByTestId("tabs-index")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Overview");
  });

  test("tabs nav shows current location", async ({ page }) => {
    await page.goto("/tabs");
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("tabs-location")).toHaveText("Current path: /tabs");
  });

  test("navigate to tabs settings preserves layout", async ({ page }) => {
    await page.goto("/tabs");
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Settings");
    // Layout should still be present
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Tabs");
  });

  test("navigate to tabs activity preserves layout", async ({ page }) => {
    await page.goto("/tabs");
    await page.waitForLoadState("networkidle");

    await page.getByRole("link", { name: "Activity" }).click();
    await expect(page.getByTestId("tabs-activity")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Activity");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
  });

  test("tabs index client component hydrates and works", async ({ page }) => {
    await page.goto("/tabs");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("tabs-overview-count")).toHaveText("Count: 0");
    await page.getByTestId("tabs-overview-increment").click();
    await expect(page.getByTestId("tabs-overview-count")).toHaveText("Count: 1");
  });

  test("tabs settings client component hydrates and works", async ({ page }) => {
    await page.goto("/tabs/settings");
    await page.waitForLoadState("networkidle");

    await expect(page.getByTestId("tabs-settings-theme")).toHaveText("Theme: light");
    await page.getByTestId("tabs-settings-dark").click();
    await expect(page.getByTestId("tabs-settings-theme")).toHaveText("Theme: dark");
  });
});

test.describe("Tabs - SSR in dev", () => {
  test("tabs layout + index SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/tabs", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-index")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Tabs");
  });

  test("tabs settings SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/tabs/settings", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();
  });
});

test.describe("Tabs - direct URL access in dev", () => {
  test("load /tabs directly", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-index")).toBeVisible();
  });

  test("load /tabs/settings directly", async ({ page }) => {
    await page.goto("/tabs/settings");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();
  });

  test("load /tabs/activity directly", async ({ page }) => {
    await page.goto("/tabs/activity");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-activity")).toBeVisible();
  });
});

// ===========================================
// Suspense Streaming (dev mode)
// ===========================================

test.describe("Suspense - page load and streaming", () => {
  test("suspense page renders layout and section headings", async ({ page }) => {
    await page.goto("/suspense");
    await expect(page.locator("h1")).toHaveText("Suspense Examples");
    await expect(page.getByTestId("suspense-page")).toBeVisible();
    await expect(page.getByTestId("suspense-section-basic")).toBeVisible();
    await expect(page.getByTestId("suspense-section-parallel")).toBeVisible();
    await expect(page.getByTestId("suspense-section-nested")).toBeVisible();
  });

  test("basic suspense: content streams in after fallback", async ({ page }) => {
    await page.goto("/suspense");
    // Posts should eventually resolve (~5s delay + network)
    await expect(page.getByTestId("suspense-posts").first()).toBeVisible({ timeout: 15_000 });
    // Verify actual post content rendered
    await expect(page.getByTestId("suspense-posts").first().locator("li").first()).toBeVisible();
  });

  test("parallel streaming: users resolve before posts", async ({ page }) => {
    await page.goto("/suspense");
    // Users have a 2s delay, posts have 5s — users should resolve first
    await expect(page.getByTestId("suspense-users")).toBeVisible({ timeout: 8_000 });
    // Posts in the parallel section should eventually resolve too
    await expect(page.getByTestId("suspense-posts").last()).toBeVisible({ timeout: 15_000 });
  });

  test("nested suspense: outer resolves before inner", async ({ page }) => {
    await page.goto("/suspense");
    // Outer content resolves after ~3s
    await expect(page.getByTestId("suspense-outer-content")).toBeVisible({ timeout: 10_000 });
    // Inner comments resolve after ~3s + ~4s = ~7s total
    await expect(page.getByTestId("suspense-inner-comments")).toBeVisible({ timeout: 15_000 });
  });
});

test.describe("Suspense - SSR in dev", () => {
  test("SSR renders layout and fallbacks without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/suspense", { waitUntil: "domcontentloaded" });

    // Layout should be SSR rendered
    await expect(page.locator("h1")).toHaveText("Suspense Examples");
    // Section headings should be visible (synchronous content)
    await expect(page.getByText("1. Basic Suspense")).toBeVisible();
    await expect(page.getByText("2. Parallel Streaming")).toBeVisible();
    await expect(page.getByText("3. Nested Suspense")).toBeVisible();
  });

  test("SSR streams resolved content into HTML", async ({ page }) => {
    await page.goto("/suspense");
    // Wait for streaming to complete
    await expect(page.getByTestId("suspense-posts").first()).toBeVisible({ timeout: 15_000 });
    // Verify the page has real post data
    await expect(page.getByTestId("suspense-posts").first().locator("li")).toHaveCount(5);
  });
});

test.describe("Suspense - client-side navigation in dev", () => {
  test("navigate to suspense page shows fallbacks then content", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");
    await page.waitForLoadState("networkidle");

    // Navigate to suspense page
    await page.getByRole("link", { name: "Suspense" }).first().click();
    await expect(page.locator("h1")).toHaveText("Suspense Examples");

    // Content should eventually stream in
    await expect(page.getByTestId("suspense-users")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("suspense-posts").first()).toBeVisible({ timeout: 15_000 });
  });

  test("navigate from suspense to another page works", async ({ page }) => {
    await page.goto("/suspense");
    await expect(page.locator("h1")).toHaveText("Suspense Examples");
    await page.waitForLoadState("networkidle");

    // Navigate away
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    // Suspense page content should no longer be visible
    await expect(page.getByTestId("suspense-page")).not.toBeVisible();
  });

  test("RSC endpoint is fetched during navigation to suspense", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");
    await page.waitForLoadState("networkidle");

    const [req] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("__rsc")),
      page.getByRole("link", { name: "Suspense" }).first().click(),
    ]);

    await expect(page.locator("h1")).toHaveText("Suspense Examples");
    expect(req.url()).toContain("__rsc");
  });
});

test.describe("Suspense - direct URL access in dev", () => {
  test("load /suspense directly", async ({ page }) => {
    await page.goto("/suspense");
    await expect(page.locator("h1")).toHaveText("Suspense Examples");
    await expect(page.locator("nav").first()).toBeVisible();
  });
});

// ===========================================
// Cancelled request tracking (dev)
// ===========================================

test.describe("Cancelled request tracking", () => {
  const DEV_URL = "http://localhost:5173";

  /** Helper: poll the perf API until a matching event appears */
  async function waitForEvent(predicate: (e: any) => boolean, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await fetch(`${DEV_URL}/api/perf/events?limit=100`);
      const events = await res.json();
      const match = events.find(predicate);
      if (match) return match;
      await new Promise((r) => setTimeout(r, 200));
    }
    return undefined;
  }

  test("cancelled RSC request produces a cancelled event", async () => {
    // Use Node.js http.request to make a request we can forcefully destroy.
    // Browser fetch with HTTP/1.1 keep-alive doesn't close the TCP socket
    // when aborted, so the server can't detect the disconnection.
    await fetch(`${DEV_URL}/api/perf/events`, { method: "DELETE" });

    const req = http.request({
      hostname: "localhost",
      port: 5173,
      path: "/__rsc?url=%2Fslow",
      headers: { Connection: "close" },
    });
    req.on("error", () => {}); // Ignore socket errors from destroy()
    req.end();

    // Let the request reach the server and start the 3s render
    await new Promise((r) => setTimeout(r, 500));

    // Destroy the connection — triggers res.close on the dev server
    req.destroy();

    // Wait for the server to finish rendering and record the cancelled event
    const cancelledEvent = await waitForEvent(
      (e: any) => e.cancelled === true && e.pathname.includes("/slow"),
    );
    expect(cancelledEvent).toBeTruthy();
    expect(cancelledEvent.type).toBe("RSC");
  });

  test("non-cancelled request does not have cancelled flag", async ({ page }) => {
    await fetch(`${DEV_URL}/api/perf/events`, { method: "DELETE" });

    await page.goto("/about");
    await expect(page.locator("h1")).toHaveText("About");

    const aboutEvent = await waitForEvent((e: any) => e.pathname.includes("/about"), 5_000);

    expect(aboutEvent).toBeTruthy();
    expect(aboutEvent.cancelled).toBeFalsy();
  });
});
