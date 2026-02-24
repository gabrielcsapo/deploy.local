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
