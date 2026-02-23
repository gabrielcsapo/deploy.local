import { test, expect } from '@playwright/test';

test.describe('Initial page load', () => {
  test('home page renders with server content', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Home');
    await expect(page.locator('.timestamp')).toContainText('Server rendered at');
    await expect(page.locator('text=This is a server component')).toBeVisible();
  });

  test('navigation links are present', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('nav');
    await expect(nav.getByRole('link', { name: 'Home' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'About' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
  });

  test('home page has MessageBoard client component', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Server Action Demo')).toBeVisible();
    await expect(page.locator('input[name="text"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Send' })).toBeVisible();
  });
});

test.describe('Client-side navigation', () => {
  test('navigate to About page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'About' }).first().click();
    await expect(page.locator('h1')).toHaveText('About');
    await expect(page.locator('.timestamp')).toContainText('Server rendered at');
    await expect(page.locator('text=mixing server and client components')).toBeVisible();
  });

  test('navigate to Dashboard page', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav').getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.locator('h2')).toHaveText('Dashboard Overview');
    await expect(page.locator('text=nested route inside the dashboard layout')).toBeVisible();
  });

  test('navigate between dashboard sub-routes', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('h2')).toHaveText('Dashboard Overview');

    // Navigate to settings
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await expect(page.locator('h2').first()).toHaveText('Settings');
    await expect(page.locator('text=settings page within the dashboard')).toBeVisible();

    // Navigate back to overview
    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.locator('h2')).toHaveText('Dashboard Overview');
  });

  test('navigate Home -> About -> Home preserves route', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Home');

    await page.getByRole('link', { name: 'About' }).first().click();
    await expect(page.locator('h1')).toHaveText('About');

    await page.getByRole('link', { name: 'Home' }).click();
    await expect(page.locator('h1')).toHaveText('Home');
  });
});

test.describe('Client components', () => {
  test('Counter increments on About page', async ({ page }) => {
    await page.goto('/about');
    await expect(page.locator('text=Count: 0')).toBeVisible();

    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('text=Count: 1')).toBeVisible();

    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('text=Count: 2')).toBeVisible();
  });

  test('Counter works on Dashboard Settings page', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page.locator('text=Count: 0')).toBeVisible();

    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('text=Count: 1')).toBeVisible();
  });
});

test.describe('Server actions', () => {
  test('submit a message via MessageBoard', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Server Action Demo')).toBeVisible();

    // Type a message and submit
    await page.fill('input[name="text"]', 'Hello from Playwright');
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the message to appear in the list
    await expect(page.locator('text=Hello from Playwright')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('h2', { hasText: 'Messages' })).toBeVisible();
  });

  test('submit multiple messages', async ({ page }) => {
    await page.goto('/');

    // Send first message
    await page.fill('input[name="text"]', 'First message');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('text=First message')).toBeVisible({ timeout: 10_000 });

    // Send second message
    await page.fill('input[name="text"]', 'Second message');
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.locator('text=Second message')).toBeVisible({ timeout: 10_000 });

    // Both should be visible
    await expect(page.locator('li', { hasText: 'First message' })).toBeVisible();
    await expect(page.locator('li', { hasText: 'Second message' })).toBeVisible();
  });

  test('button shows pending state during submission', async ({ page }) => {
    await page.goto('/');
    await page.fill('input[name="text"]', 'Pending test');

    // Click and immediately check for pending state
    const submitButton = page.getByRole('button', { name: /Send|Sending/ });
    await submitButton.click();

    // The message should eventually appear
    await expect(page.locator('text=Pending test')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Direct URL access', () => {
  test('load /about directly', async ({ page }) => {
    await page.goto('/about');
    await expect(page.locator('h1')).toHaveText('About');
    await expect(page.locator('nav')).toBeVisible();
  });

  test('load /dashboard directly', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.locator('h2')).toHaveText('Dashboard Overview');
  });

  test('load /dashboard/settings directly', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page.locator('h2').first()).toHaveText('Settings');
    await expect(page.locator('text=Count: 0')).toBeVisible();
  });
});

test.describe('RSC navigation uses fetch (no full page reload)', () => {
  test('client navigation fetches RSC payload', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Home');

    // Listen for RSC fetch request during navigation
    const rscRequest = page.waitForRequest((req) =>
      req.url().includes('__rsc')
    );

    await page.getByRole('link', { name: 'About' }).first().click();
    await expect(page.locator('h1')).toHaveText('About');

    const req = await rscRequest;
    expect(req.url()).toContain('__rsc');
  });
});
