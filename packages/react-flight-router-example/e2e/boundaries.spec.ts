import { test, expect } from "@playwright/test";

test.describe("Route-config loading boundary", () => {
  test("shows loading skeleton during navigation to slow child", async ({ page }) => {
    // Start on the loading demo index page
    await page.goto("/loading-with-component");
    await expect(page.locator("h1")).toHaveText("Loading Boundary Demo");
    await expect(page.getByTestId("loading-demo-index")).toBeVisible();

    // Click the link to the slow child
    await page.getByTestId("nav-slow-child").click();

    // The loading skeleton should appear immediately (before server responds)
    await expect(page.getByTestId("loading-skeleton")).toBeVisible({ timeout: 2000 });

    // After ~3s, the real content should replace the skeleton
    await expect(page.getByTestId("slow-child-content")).toBeVisible({ timeout: 10000 });

    // The loading skeleton should be gone
    await expect(page.getByTestId("loading-skeleton")).not.toBeVisible();
  });

  test("loading skeleton shows on client-side navigation from another page", async ({ page }) => {
    // Start on Home
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("Home");

    // Navigate to loading demo
    await page.locator("nav").first().getByRole("link", { name: "Loading" }).click();
    await expect(page.locator("h1")).toHaveText("Loading Boundary Demo");

    // Navigate to the slow child
    await page.getByTestId("nav-slow-child").click();

    // Loading skeleton should appear
    await expect(page.getByTestId("loading-skeleton")).toBeVisible({ timeout: 2000 });

    // Then real content replaces it
    await expect(page.getByTestId("slow-child-content")).toBeVisible({ timeout: 10000 });
  });
});

test.describe("Route-config error boundary", () => {
  test("catches client-side render error and shows fallback", async ({ page }) => {
    // Start on the error demo index page
    await page.goto("/error-with-component");
    await expect(page.locator("h1")).toHaveText("Error Boundary Demo");
    await expect(page.getByTestId("error-demo-index")).toBeVisible();

    // Navigate to the client error page
    await page.getByTestId("nav-client-error").click();

    // The error fallback should appear (catching the client render error)
    await expect(page.getByTestId("error-fallback")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("error-fallback")).toContainText("Something went wrong");
    await expect(page.getByTestId("error-fallback")).toContainText(
      "intentionally throws during client render",
    );
  });

  test("error boundary shows fallback on direct navigation", async ({ page }) => {
    // Navigate directly to the error-throwing page
    await page.goto("/error-with-component/client-error");

    // The layout should render
    await expect(page.locator("h1")).toHaveText("Error Boundary Demo");

    // The error fallback should catch the client-side render error
    await expect(page.getByTestId("error-fallback")).toBeVisible({ timeout: 5000 });
    await expect(page.getByTestId("error-fallback")).toContainText("Something went wrong");
  });

  test("can navigate back from error state", async ({ page }) => {
    await page.goto("/error-with-component");
    await expect(page.getByTestId("error-demo-index")).toBeVisible();

    // Navigate to error page
    await page.getByTestId("nav-client-error").click();
    await expect(page.getByTestId("error-fallback")).toBeVisible({ timeout: 5000 });

    // Navigate back to the index using the link in the error fallback
    await page.getByTestId("error-fallback").getByRole("link").click();
    await expect(page.getByTestId("error-demo-index")).toBeVisible({ timeout: 5000 });
  });
});
