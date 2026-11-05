import { test, expect, type Page } from "@playwright/test";

function uniqueUser() {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  return {
    username: `test-${id}`,
    password: "testpass123",
  };
}

async function registerViaAPI(page: Page, user = uniqueUser()) {
  const res = await page.request.post("/api/auth/register", {
    data: { username: user.username, password: user.password },
  });
  expect(res.ok()).toBe(true);
  return user;
}

// ---------------------------------------------------------------------------
// Registration (dev)
// ---------------------------------------------------------------------------

test.describe("Auth - Registration (dev)", () => {
  test("registers via UI form and redirects to home", async ({ page }) => {
    const user = uniqueUser();

    await page.goto("/register");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1")).toHaveText("Register");

    await page.fill("#username", user.username);
    await page.fill("#password", user.password);
    await page.fill("#confirm", user.password);
    await page.click('button[type="submit"]');

    await page.waitForURL("/");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Login (dev)
// ---------------------------------------------------------------------------

test.describe("Auth - Login (dev)", () => {
  test("logs in with valid credentials", async ({ page }) => {
    const user = await registerViaAPI(page);
    await page.context().clearCookies();

    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    await page.fill("#username", user.username);
    await page.fill("#password", user.password);
    await page.click('button[type="submit"]');

    await page.waitForURL("/");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 15_000 });
  });

  test("shows error for invalid credentials", async ({ page }) => {
    const user = await registerViaAPI(page);
    await page.context().clearCookies();

    await page.goto("/login");
    await page.waitForLoadState("networkidle");

    await page.fill("#username", user.username);
    await page.fill("#password", "wrongpassword");
    await page.click('button[type="submit"]');

    await expect(page.locator("text=Invalid credentials")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Session persistence (dev)
// ---------------------------------------------------------------------------

test.describe("Auth - Session persistence (dev)", () => {
  test("session persists across page reloads", async ({ page }) => {
    const user = await registerViaAPI(page);

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// Logout (dev)
// ---------------------------------------------------------------------------

test.describe("Auth - Logout (dev)", () => {
  test("logout clears session", async ({ page }) => {
    const user = await registerViaAPI(page);

    await page.goto("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 15_000 });

    await page.click("text=Sign out");

    await page.waitForURL("/");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("text=Sign in")).toBeVisible({ timeout: 15_000 });
  });
});

// ---------------------------------------------------------------------------
// onRequest context (dev)
// ---------------------------------------------------------------------------

test.describe("Auth - onRequest context (dev)", () => {
  test("profile server component reads session in dev mode", async ({ page }) => {
    const user = await registerViaAPI(page);

    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="profile-username"]')).toHaveText(user.username);
  });

  test("profile shows 'Not logged in' when no session in dev mode", async ({ page }) => {
    await page.goto("/profile");
    await page.waitForLoadState("networkidle");
    await expect(page.locator('[data-testid="not-logged-in"]')).toBeVisible();
  });
});
