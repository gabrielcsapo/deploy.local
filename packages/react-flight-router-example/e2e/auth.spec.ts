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
  const body = await res.json();
  expect(body.user).toBeTruthy();
  expect(body.user.username).toBe(user.username);
  return user;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

test.describe("Auth - Registration", () => {
  test("registers via UI form and redirects to home as logged in", async ({ page }) => {
    const user = uniqueUser();

    await page.goto("/register");
    await expect(page.locator("h1")).toHaveText("Register");

    await page.fill("#username", user.username);
    await page.fill("#password", user.password);
    await page.fill("#confirm", user.password);
    await page.click('button[type="submit"]');

    // Should redirect to home and show the username in the auth nav
    await page.waitForURL("/");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test("shows error for duplicate username", async ({ page }) => {
    const user = await registerViaAPI(page);

    await page.goto("/register");
    await page.fill("#username", user.username);
    await page.fill("#password", user.password);
    await page.fill("#confirm", user.password);
    await page.click('button[type="submit"]');

    await expect(page.locator("text=Username already taken")).toBeVisible();
  });

  test("shows error for short password via API", async ({ page }) => {
    const res = await page.request.post("/api/auth/register", {
      data: { username: "shortpw", password: "ab" },
    });
    const body = await res.json();
    expect(body.error).toBe("Password must be at least 6 characters");
  });

  test("shows error for mismatched passwords", async ({ page }) => {
    await page.goto("/register");
    await page.fill("#username", "mismatch");
    await page.fill("#password", "password123");
    await page.fill("#confirm", "differentpass");
    await page.click('button[type="submit"]');

    await expect(page.locator("text=Passwords do not match")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

test.describe("Auth - Login", () => {
  test("logs in with valid credentials", async ({ page }) => {
    const user = await registerViaAPI(page);
    await page.context().clearCookies();

    await page.goto("/login");
    await expect(page.locator("h1")).toHaveText("Sign In");

    await page.fill("#username", user.username);
    await page.fill("#password", user.password);
    await page.click('button[type="submit"]');

    await page.waitForURL("/");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test("shows error for invalid credentials", async ({ page }) => {
    const user = await registerViaAPI(page);
    await page.context().clearCookies();

    await page.goto("/login");
    await page.fill("#username", user.username);
    await page.fill("#password", "wrongpassword");
    await page.click('button[type="submit"]');

    await expect(page.locator("text=Invalid credentials")).toBeVisible();
  });

  test("shows error for non-existent user", async ({ page }) => {
    await page.goto("/login");
    await page.fill("#username", "nonexistent-user-xyz");
    await page.fill("#password", "somepassword");
    await page.click('button[type="submit"]');

    await expect(page.locator("text=Invalid credentials")).toBeVisible();
  });
});

// ---------------------------------------------------------------------------
// Session persistence
// ---------------------------------------------------------------------------

test.describe("Auth - Session persistence", () => {
  test("session persists across page reloads", async ({ page }) => {
    const user = await registerViaAPI(page);

    await page.goto("/");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 10_000 });
  });

  test("profile page shows username from server component (onRequest)", async ({ page }) => {
    const user = await registerViaAPI(page);

    await page.goto("/profile");
    // The profile server component reads the session via getSessionUser()
    // which uses AsyncLocalStorage populated by onRequest
    await expect(page.locator('[data-testid="profile-username"]')).toHaveText(user.username);
  });
});

// ---------------------------------------------------------------------------
// Logout
// ---------------------------------------------------------------------------

test.describe("Auth - Logout", () => {
  test("logout clears session and shows sign in link", async ({ page }) => {
    const user = await registerViaAPI(page);

    await page.goto("/");
    await expect(page.locator(`text=${user.username}`).first()).toBeVisible({ timeout: 10_000 });

    // Click "Sign out" button
    await page.click("text=Sign out");

    // Should reload and show sign in / sign up links
    await page.waitForURL("/");
    await expect(page.locator("text=Sign in")).toBeVisible({ timeout: 10_000 });
    await expect(page.locator("text=Sign up")).toBeVisible();
  });

  test("after logout, session cookie is cleared", async ({ page }) => {
    await registerViaAPI(page);

    await page.request.post("/api/auth/logout");

    const res = await page.request.get("/api/auth/me");
    const body = await res.json();
    expect(body.user).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// onRequest context (server component auth)
// ---------------------------------------------------------------------------

test.describe("Auth - onRequest context", () => {
  test("profile server component reads session via AsyncLocalStorage", async ({ page }) => {
    const user = await registerViaAPI(page);

    // Direct navigation to /profile — SSR renders with the session
    await page.goto("/profile");
    await expect(page.locator('[data-testid="profile-username"]')).toHaveText(user.username);
    await expect(page.locator("text=getSessionUser()")).toBeVisible();
  });

  test("profile shows 'Not logged in' when no session", async ({ page }) => {
    await page.goto("/profile");
    await expect(page.locator('[data-testid="not-logged-in"]')).toBeVisible();
    await expect(page.locator("text=Not logged in")).toBeVisible();
  });

  test("profile updates after login via client navigation", async ({ page }) => {
    const user = await registerViaAPI(page);
    await page.context().clearCookies();

    // Visit profile while logged out
    await page.goto("/profile");
    await expect(page.locator('[data-testid="not-logged-in"]')).toBeVisible();

    // Login via API
    await page.request.post("/api/auth/login", {
      data: { username: user.username, password: user.password },
    });

    // Full reload to pick up new session in server component
    await page.goto("/profile");
    await expect(page.locator('[data-testid="profile-username"]')).toHaveText(user.username);
  });
});
