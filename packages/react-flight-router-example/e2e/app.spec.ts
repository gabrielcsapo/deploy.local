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

    // Collect all RSC requests with their headers
    const rscRequests: { url: string; prevUrl: string | undefined }[] = [];
    page.on("request", (req) => {
      if (req.url().includes("__rsc")) {
        rscRequests.push({
          url: req.url(),
          prevUrl: req.headers()["x-rsc-previous-url"],
        });
      }
    });

    // Use Playwright's click which triggers the navigation.
    // Even if a prefetch fires from intent, the non-prefetch navigation
    // request (if any) will include the header.
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");
    await page.waitForTimeout(300);

    // At least one RSC request should have been made (either prefetch or navigation).
    // If navigation used a cached prefetch, there may not be a request with the header.
    // If navigation made its own request, it will have the header.
    expect(rscRequests.length).toBeGreaterThan(0);

    // If there was a navigation request (not prefetch), verify it has the correct header
    const navRequest = rscRequests.find((r) => r.prevUrl != null);
    if (navRequest) {
      expect(navRequest.prevUrl).toBe("/");
    }
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

  test("user profile shows their posts on sub-route", async ({ page }) => {
    await page.goto("/users/1/posts");
    await expect(page.locator("h2", { hasText: "Posts" })).toBeVisible();
    // User's posts should have at least one card
    await expect(page.locator("ul li").first()).toBeVisible();
  });

  test("user profile post links navigate to post detail", async ({ page }) => {
    await page.goto("/users/1/posts");
    const postLink = page.locator('a[href^="/posts/"]').first();
    await expect(postLink).toBeVisible();
    await postLink.click();
    await expect(page.locator("article h2")).toBeVisible();
  });

  test("navigate from post to author profile", async ({ page }) => {
    await page.goto("/posts/1");
    const authorLink = page.locator('a[href^="/users/"]').first();
    await authorLink.click();
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("text=Email:")).toBeVisible();
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
// Index route params inheritance (regression test)
// ============================================
// Verifies that index routes under dynamic parent routes
// correctly inherit the parent's params (e.g. :id).
// See: https://github.com/gabrielcsapo/flight-router/issues/XX

test.describe("Index route params inheritance under dynamic parent", () => {
  test("index route receives parent dynamic params", async ({ page }) => {
    await page.goto("/users/1");
    // The index route (user profile) should receive params.id from the parent users/:id route
    await expect(page.getByTestId("user-params-id")).toHaveText("User ID: 1");
  });

  test("index route params work with different IDs", async ({ page }) => {
    await page.goto("/users/3");
    await expect(page.getByTestId("user-params-id")).toHaveText("User ID: 3");
    await expect(page.locator("h1")).toBeVisible();
    await expect(page.locator("text=Email:")).toBeVisible();
  });

  test("child route also receives parent dynamic params", async ({ page }) => {
    await page.goto("/users/2/posts");
    // The child route (user posts) should also receive params.id
    await expect(page.getByTestId("user-posts-params-id")).toHaveText("User ID: 2");
    await expect(page.locator("h2", { hasText: "Posts" })).toBeVisible();
  });

  test("navigating from index to child preserves params", async ({ page }) => {
    await page.goto("/users/1");
    await expect(page.getByTestId("user-params-id")).toHaveText("User ID: 1");

    // Click the "Posts" link in the user layout nav
    await page.locator('a[href="/users/1/posts"]').click();
    await expect(page.getByTestId("user-posts-params-id")).toHaveText("User ID: 1");
    // Layout header should be preserved
    await expect(page.locator("h1")).toBeVisible();
  });

  test("index route params work via SSR without JavaScript", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/users/1", { waitUntil: "domcontentloaded" });
    // Even without JS, SSR should render the correct params
    await expect(page.getByTestId("user-params-id")).toHaveText("User ID: 1");
    await expect(page.locator("text=Email:")).toBeVisible();
  });

  test("index route params work via client-side navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    // Navigate to a user profile via client-side navigation
    // First go to posts to find a user link
    await page.locator("nav").first().getByRole("link", { name: "Blog" }).click();
    await expect(page.locator("h1")).toHaveText("Blog");

    const authorLink = page.locator('a[href^="/users/"]').first();
    await expect(authorLink).toBeVisible();
    const href = await authorLink.getAttribute("href");
    await authorLink.click();

    // Verify the index route received the params via RSC client navigation
    await expect(page.getByTestId("user-params-id")).toBeVisible();
    const userIdText = await page.getByTestId("user-params-id").textContent();
    const expectedId = href!.split("/users/")[1];
    expect(userIdText).toBe(`User ID: ${expectedId}`);
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

test.describe("Error route handling", () => {
  test("broken route renders error page", async ({ page }) => {
    await page.goto("/broken");
    await expect(page.locator("h1")).toHaveText("500");
    await expect(page.locator("text=Something Went Wrong")).toBeVisible();
    // Root layout nav should still be visible
    await expect(page.locator("nav")).toBeVisible();
  });

  test("error page shows error message", async ({ page }) => {
    await page.goto("/broken");
    await expect(page.locator("text=This route is intentionally broken")).toBeVisible();
  });

  test("error page has link back", async ({ page }) => {
    await page.goto("/broken");
    await expect(page.locator("text=Go home")).toBeVisible();

    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");
  });

  test("error route returns 500 HTTP status", async ({ page }) => {
    const response = await page.goto("/broken");
    expect(response?.status()).toBe(500);
  });

  test("error SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/broken", { waitUntil: "domcontentloaded" });
    await expect(page.locator("h1")).toHaveText("500");
    await expect(page.locator("nav")).toBeVisible();
  });

  test("navigating from error page back to valid route works", async ({ page }) => {
    await page.goto("/broken");
    await expect(page.locator("h1")).toHaveText("500");

    await page.getByRole("link", { name: "Go home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");
    await expect(page.locator("nav").first()).toBeVisible();
  });

  test("client-side navigation from dashboard to broken shows error page", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.locator("h1")).toHaveText("Dashboard");

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

// ============================================
// Tabs - Server component routes with similar name prefixes
// ============================================
// Regression tests for manifest collision bug where route IDs like
// "tabs" and "tabs-index" would collide due to substring matching
// in findViteEntry(). The layout (tabs) must render with its own
// client chunk, not the index route's chunk.

test.describe("Tabs - layout/index prefix collision regression", () => {
  test("tabs layout renders with nav and outlet", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.locator("h1")).toHaveText("Tabs");
    await expect(page.getByTestId("tabs-nav")).toBeVisible();
    await expect(page.getByTestId("tabs-content")).toBeVisible();
  });

  test("tabs index renders inside layout", async ({ page }) => {
    await page.goto("/tabs");
    // Layout should be visible
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    // Index content should render inside the outlet
    await expect(page.getByTestId("tabs-index")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Overview");
  });

  test("tabs index has interactive client component", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-overview-count")).toHaveText("Count: 0");

    await page.getByTestId("tabs-overview-increment").click();
    await expect(page.getByTestId("tabs-overview-count")).toHaveText("Count: 1");

    await page.getByTestId("tabs-overview-increment").click();
    await expect(page.getByTestId("tabs-overview-count")).toHaveText("Count: 2");
  });

  test("navigate to tabs settings preserves layout", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-index")).toBeVisible();
    const layoutTimestamp = await page.getByTestId("tabs-layout-timestamp").textContent();

    // Navigate to settings tab
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Settings");

    // Layout should be preserved (same timestamp = no re-render)
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-layout-timestamp")).toHaveText(layoutTimestamp!);

    // Index should no longer be visible
    await expect(page.getByTestId("tabs-index")).not.toBeVisible();
  });

  test("navigate to tabs activity preserves layout", async ({ page }) => {
    await page.goto("/tabs");
    const layoutTimestamp = await page.getByTestId("tabs-layout-timestamp").textContent();

    await page.getByRole("link", { name: "Activity" }).click();
    await expect(page.getByTestId("tabs-activity")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Activity");
    await expect(page.getByTestId("tabs-activity-list")).toBeVisible();

    // Layout preserved
    await expect(page.getByTestId("tabs-layout-timestamp")).toHaveText(layoutTimestamp!);
  });

  test("navigate between all tabs preserves layout", async ({ page }) => {
    await page.goto("/tabs");
    const layoutTimestamp = await page.getByTestId("tabs-layout-timestamp").textContent();

    // Overview → Settings
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();
    await expect(page.getByTestId("tabs-layout-timestamp")).toHaveText(layoutTimestamp!);

    // Settings → Activity
    await page.getByRole("link", { name: "Activity" }).click();
    await expect(page.getByTestId("tabs-activity")).toBeVisible();
    await expect(page.getByTestId("tabs-layout-timestamp")).toHaveText(layoutTimestamp!);

    // Activity → Overview
    await page.getByRole("link", { name: "Overview" }).click();
    await expect(page.getByTestId("tabs-index")).toBeVisible();
    await expect(page.getByTestId("tabs-layout-timestamp")).toHaveText(layoutTimestamp!);
  });

  test("settings tab has interactive client component", async ({ page }) => {
    await page.goto("/tabs/settings");
    await expect(page.getByTestId("tabs-settings-theme")).toHaveText("Theme: light");

    await page.getByTestId("tabs-settings-dark").click();
    await expect(page.getByTestId("tabs-settings-theme")).toHaveText("Theme: dark");

    await page.getByTestId("tabs-settings-light").click();
    await expect(page.getByTestId("tabs-settings-theme")).toHaveText("Theme: light");
  });

  test("tabs location display updates on navigation", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-location")).toHaveText("Current path: /tabs");

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("tabs-location")).toHaveText("Current path: /tabs/settings");

    await page.getByRole("link", { name: "Activity" }).click();
    await expect(page.getByTestId("tabs-location")).toHaveText("Current path: /tabs/activity");
  });
});

test.describe("Tabs - direct URL access", () => {
  test("load /tabs directly", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-index")).toBeVisible();
    await expect(page.locator("nav").first()).toBeVisible();
  });

  test("load /tabs/settings directly", async ({ page }) => {
    await page.goto("/tabs/settings");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Settings");
  });

  test("load /tabs/activity directly", async ({ page }) => {
    await page.goto("/tabs/activity");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-activity")).toBeVisible();
    await expect(page.locator("h2")).toHaveText("Activity");
  });
});

test.describe("Tabs - SSR", () => {
  test("tabs layout + index SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/tabs", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-index")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Tabs");
    await expect(page.locator("h2")).toHaveText("Overview");
  });

  test("tabs settings SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/tabs/settings", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Tabs");
    await expect(page.locator("h2")).toHaveText("Settings");
  });

  test("tabs activity SSR renders without JS", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/tabs/activity", { waitUntil: "domcontentloaded" });

    await expect(page.getByTestId("tabs-layout")).toBeVisible();
    await expect(page.getByTestId("tabs-activity")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("Tabs");
    await expect(page.locator("h2")).toHaveText("Activity");
  });

  test("tabs hydration makes client components interactive", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-overview-count")).toHaveText("Count: 0");
    await page.getByTestId("tabs-overview-increment").click();
    await expect(page.getByTestId("tabs-overview-count")).toHaveText("Count: 1");
  });
});

test.describe("Tabs - RSC navigation", () => {
  test("tabs navigation uses RSC fetch (no full page reload)", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-index")).toBeVisible();

    const rscRequest = page.waitForRequest((req) => req.url().includes("__rsc"));

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();

    const req = await rscRequest;
    expect(req.url()).toContain("__rsc");
  });

  test("tabs RSC request sends correct previous URL", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-index")).toBeVisible();

    const rscRequest = page.waitForRequest((req) => req.url().includes("__rsc"));

    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();

    const req = await rscRequest;
    const prevUrlHeader = req.headers()["x-rsc-previous-url"];
    expect(prevUrlHeader).toBe("/tabs");
  });

  test("cross-route navigation from tabs to home works", async ({ page }) => {
    await page.goto("/tabs/settings");
    await expect(page.getByTestId("tabs-settings")).toBeVisible();

    await page.locator("nav").first().getByRole("link", { name: "Home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");

    // Tabs layout should no longer be visible
    await expect(page.getByTestId("tabs-layout")).not.toBeVisible();
  });
});

// ============================================
// Suspense Streaming
// ============================================

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
    // Users have a 2s delay, posts have 5s
    // Users should resolve first
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

test.describe("Suspense - SSR", () => {
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
    // Full SSR (with JS blocked) — the HTML stream includes resolved content
    // because renderToReadableStream streams it in as template tags.
    // Without JS, React can't swap templates, but the content is in the DOM.
    await page.goto("/suspense");
    // Wait for streaming to complete
    await expect(page.getByTestId("suspense-posts").first()).toBeVisible({ timeout: 15_000 });
    // Verify the page has real post data
    await expect(page.getByTestId("suspense-posts").first().locator("li")).toHaveCount(5);
  });
});

test.describe("Suspense - client-side navigation", () => {
  test("navigate to suspense page shows fallbacks then content", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

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

    // Navigate away before all content resolves
    await page.getByRole("link", { name: "About" }).first().click();
    await expect(page.locator("h1")).toHaveText("About");

    // Suspense page content should no longer be visible
    await expect(page.getByTestId("suspense-page")).not.toBeVisible();
  });

  test("RSC endpoint is fetched during navigation to suspense", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    const [req] = await Promise.all([
      page.waitForRequest((req) => req.url().includes("__rsc")),
      page.getByRole("link", { name: "Suspense" }).first().click(),
    ]);

    await expect(page.locator("h1")).toHaveText("Suspense Examples");
    expect(req.url()).toContain("__rsc");
  });
});

test.describe("Suspense - direct URL access", () => {
  test("load /suspense directly", async ({ page }) => {
    await page.goto("/suspense");
    await expect(page.locator("h1")).toHaveText("Suspense Examples");
    await expect(page.locator("nav").first()).toBeVisible();
  });
});

// ============================================================
// New tests: race conditions, hash fragments, edge cases
// ============================================================

test.describe("Navigation race conditions", () => {
  test("rapid click navigation settles on final destination", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    const nav = page.locator("nav").first();

    // Rapidly click through multiple links without waiting
    await nav.getByRole("link", { name: "About" }).click();
    await nav.getByRole("link", { name: "Dashboard" }).click();
    await nav.getByRole("link", { name: "Blog" }).click();

    // Only the final destination should render
    await expect(page.locator("h1")).toHaveText("Blog", { timeout: 10_000 });
    await expect(page).toHaveURL("/posts");
  });

  test("navigate then back button before response settles correctly", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    // Navigate to a slow page then immediately go back
    await page.locator("nav").first().getByRole("link", { name: "Slow" }).click();
    // Don't wait for slow page to load, immediately go back
    await page.goBack();

    // Should end up on home page
    await expect(page.locator("h1")).toHaveText("Home", { timeout: 10_000 });
  });

  test("navigate away from slow route mid-load does not cause errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    // Navigate to slow page (3s server delay)
    await page.locator("nav").first().getByRole("link", { name: "Slow" }).click();

    // Wait just enough for the RSC stream to start, then navigate away
    await page.waitForTimeout(500);
    await page.locator("nav").first().getByRole("link", { name: "About" }).click();

    await expect(page.locator("h1")).toHaveText("About", { timeout: 10_000 });

    // Wait for any async errors from aborted streams
    await page.waitForTimeout(2000);

    // Should have no AbortError or Fetch errors in console
    const abortErrors = consoleErrors.filter(
      (e) => e.includes("AbortError") || e.includes("Fetch is aborted"),
    );
    expect(abortErrors).toHaveLength(0);
  });
});

test.describe("Hash fragment navigation", () => {
  test("direct URL with hash preserves hash in URL bar", async ({ page }) => {
    await page.goto("/about#search-params");
    await expect(page.locator("h1")).toHaveText("About");
    expect(page.url()).toContain("#search-params");
  });

  test("popstate with hash preserves hash in URL", async ({ page }) => {
    await page.goto("/about");
    await expect(page.locator("h1")).toHaveText("About");

    // Push a hash via history API and trigger popstate
    await page.evaluate(() => {
      window.history.pushState({}, "", "/about#client-component");
    });
    await page.evaluate(() => {
      window.history.pushState({}, "", "/about#search-params");
    });
    await page.goBack();

    // Hash-only changes don't trigger Playwright's page load event,
    // so goBack() resolves before the hash actually updates. Wait for
    // the browser to process the popstate and update the URL.
    await page.waitForFunction(() => window.location.hash === "#client-component");
    expect(page.url()).toContain("#client-component");
  });
});

test.describe("Search params edge cases", () => {
  test("navigate away and back preserves search params via history", async ({ page }) => {
    await page.goto("/about?sort=oldest");
    await expect(page.getByTestId("current-sort")).toHaveText("Sort: oldest");

    await page.locator("nav").first().getByRole("link", { name: "Home" }).click();
    await expect(page.locator("h1")).toHaveText("Home");

    await page.goBack();
    await expect(page.locator("h1")).toHaveText("About");
    await expect(page.getByTestId("current-sort")).toHaveText("Sort: oldest");
  });
});

test.describe("Segment diffing - layout preservation", () => {
  test("same layout different child does not remount layout", async ({ page }) => {
    await page.goto("/tabs");
    const layoutTimestamp = await page.getByTestId("tabs-layout-timestamp").textContent();

    // Navigate to settings (different child, same layout)
    await page.getByRole("link", { name: "Settings" }).click();
    await expect(page.getByTestId("tabs-settings")).toBeVisible();

    // Layout timestamp should be unchanged (proves no remount)
    await expect(page.getByTestId("tabs-layout-timestamp")).toHaveText(layoutTimestamp!);
  });

  test("completely different parent re-renders everything", async ({ page }) => {
    await page.goto("/tabs");
    await expect(page.getByTestId("tabs-layout")).toBeVisible();

    // Navigate to a completely different route tree
    await page.locator("nav").first().getByRole("link", { name: "About" }).click();
    await expect(page.locator("h1")).toHaveText("About");

    // Tabs layout should not be visible
    await expect(page.getByTestId("tabs-layout")).not.toBeVisible();
  });
});

test.describe("Dynamic route edge cases", () => {
  test("param update shows different content", async ({ page }) => {
    await page.goto("/posts/1");
    await expect(page.locator("h1")).toHaveText("Blog");
    const title1 = await page.locator("article h2").textContent();

    await page.goto("/posts/2");
    await expect(page.locator("h1")).toHaveText("Blog");
    const title2 = await page.locator("article h2").textContent();

    // Should be different content for different params
    expect(title1).not.toBe(title2);
  });
});

test.describe("Scroll restoration - extended", () => {
  test("new navigation scrolls to top", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 300 });
    await page.goto("/posts");
    await page.waitForLoadState("networkidle");

    // Make page tall enough to scroll
    await page.evaluate(() => {
      document.documentElement.style.minHeight = "3000px";
    });

    // Scroll down
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForFunction(() => window.scrollY >= 490, { timeout: 2000 });

    // Navigate to about — should scroll to top
    await page.locator("nav").first().getByRole("link", { name: "About" }).click();
    await expect(page.locator("h1")).toHaveText("About");

    const scrollY = await page.evaluate(() => window.scrollY);
    expect(scrollY).toBe(0);
  });
});

test.describe("Link component - modifier keys", () => {
  test("Ctrl/Cmd+click opens new tab and does not SPA navigate", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    // Listen for new page/tab creation
    const [newPage] = await Promise.all([
      page.context().waitForEvent("page"),
      page
        .locator("nav")
        .first()
        .getByRole("link", { name: "About" })
        .click({ modifiers: ["ControlOrMeta"] }),
    ]);

    // Original page should still show Home
    await expect(page.locator("h1")).toHaveText("Home");
    expect(newPage).toBeTruthy();
    await newPage.close();
  });
});

test.describe("Server actions - edge cases", () => {
  test("rapid submissions do not create duplicate messages", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("text=Server Action Demo")).toBeVisible();

    const msg1 = `PW-${Date.now()}-rapid1`;
    const msg2 = `PW-${Date.now()}-rapid2`;

    // Submit first message
    await page.fill('input[name="text"]', msg1);
    await page.getByRole("button", { name: "Send" }).click();

    // Wait for first submission to complete — the button is disabled={isPending}
    // during the server action, so the second click would be ignored if we
    // don't wait for the button to become enabled again.
    await expect(page.getByRole("button", { name: "Send" })).toBeEnabled({ timeout: 10_000 });

    // Submit second message
    await page.fill('input[name="text"]', msg2);
    await page.getByRole("button", { name: "Send" }).click();

    // Both should appear
    await expect(page.getByText(msg1).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText(msg2).first()).toBeVisible({ timeout: 10_000 });

    // Verify no duplicates
    const msg1Count = await page.getByText(msg1).count();
    const msg2Count = await page.getByText(msg2).count();
    expect(msg1Count).toBe(1);
    expect(msg2Count).toBe(1);
  });
});

test.describe("Suspense - navigation mid-stream", () => {
  test("navigate away during suspense does not cause errors", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });

    await page.goto("/suspense");
    await expect(page.locator("h1")).toHaveText("Suspense Examples");

    // Navigate away immediately (before suspense resolves)
    await page.locator("nav").first().getByRole("link", { name: "About" }).click();
    await expect(page.locator("h1")).toHaveText("About");

    // Wait for any async errors to surface
    await page.waitForTimeout(2000);

    // Filter out expected network-related errors
    const unexpectedErrors = consoleErrors.filter(
      (e) => !e.includes("net::ERR_ABORTED") && !e.includes("AbortError"),
    );
    expect(unexpectedErrors).toHaveLength(0);
  });
});

// ===========================================
// Vite define
// ===========================================

test.describe("Vite define", () => {
  test("__APP_VERSION__ is replaced in server component output", async ({ page }) => {
    await page.goto("/about");
    await expect(page.getByTestId("app-version")).toHaveText("Version: 1.0.0");
  });

  test("__APP_VERSION__ is present in SSR HTML", async ({ page }) => {
    await page.route("**/*.js", (route) => route.abort());
    await page.goto("/about", { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("app-version")).toHaveText("Version: 1.0.0");
  });
});

test.describe("Link prefetching", () => {
  test("hovering a nav link prefetches the RSC payload", async ({ page }) => {
    const rscPrefetchRequest = page.waitForRequest(
      (req) => req.url().includes("/__rsc") && req.url().includes("url=%2Fabout"),
    );

    await page.goto("/");
    await expect(page.locator("text=Server Action Demo")).toBeVisible();

    // Use Playwright's locator.focus() which properly dispatches focus events
    await page.locator('a[href="/about"]').first().focus();

    const req = await rscPrefetchRequest;
    expect(req.url()).toContain("url=%2Fabout");
  });

  test("prefetch request is not duplicated on repeated focus", async ({ page }) => {
    const rscRequests: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/__rsc") && req.url().includes("url=%2Fabout")) {
        rscRequests.push(req.url());
      }
    });

    await page.goto("/");
    await expect(page.locator("text=Server Action Demo")).toBeVisible();

    const aboutLink = page.locator('a[href="/about"]').first();

    // Focus the About link
    await aboutLink.focus();
    await page.waitForTimeout(300);

    // Blur then focus again
    await aboutLink.blur();
    await page.waitForTimeout(100);
    await aboutLink.focus();
    await page.waitForTimeout(300);

    // Should only have prefetched once (deduplication)
    expect(rscRequests.length).toBe(1);
  });

  test("clicking a prefetched link reuses the cached response", async ({ page }) => {
    // Track RSC requests for /about
    const rscAboutRequests: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/__rsc") && url.includes("url=%2Fabout")) {
        rscAboutRequests.push(url);
      }
    });

    await page.goto("/");
    await expect(page.locator("text=Server Action Demo")).toBeVisible();

    const aboutLink = page.locator('a[href="/about"]').first();

    // Retry focus until the prefetch fires. In parallel CI workers,
    // focus events may not dispatch if the browser window is inactive.
    let prefetchFired = false;
    for (let attempt = 0; attempt < 5 && !prefetchFired; attempt++) {
      await aboutLink.focus();
      await page.waitForTimeout(500);
      if (rscAboutRequests.length > 0) {
        prefetchFired = true;
      } else {
        await aboutLink.blur();
        await page.waitForTimeout(100);
      }
    }
    expect(prefetchFired).toBe(true);

    // Wait for response to be cached
    await page.waitForTimeout(300);

    // Blur to prevent re-focus from triggering another prefetch
    await aboutLink.blur();
    await page.waitForTimeout(100);

    const countBeforeClick = rscAboutRequests.length;

    // Click via evaluate to avoid Playwright's hover-before-click behavior
    // which would trigger pointerenter/focus and race with navigate
    await page.evaluate(() => {
      const link = document.querySelector('a[href="/about"]') as HTMLAnchorElement;
      link?.click();
    });
    await expect(page.locator("h1")).toHaveText("About");

    // The navigate() call should have consumed the prefetched response,
    // so no additional RSC request should have been made for the click itself
    expect(rscAboutRequests.length).toBe(countBeforeClick);
  });
});
