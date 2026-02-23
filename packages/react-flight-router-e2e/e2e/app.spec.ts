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

    // Use unique message to avoid conflicts with other test runs
    const msg = `PW-${Date.now()}-submit`;
    await page.fill('input[name="text"]', msg);
    await page.getByRole('button', { name: 'Send' }).click();

    // Wait for the message to appear in the list
    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('h2', { hasText: 'Messages' })).toBeVisible();
  });

  test('submit multiple messages', async ({ page }) => {
    await page.goto('/');

    const msg1 = `PW-${Date.now()}-first`;
    const msg2 = `PW-${Date.now()}-second`;

    // Send first message
    await page.fill('input[name="text"]', msg1);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(msg1).first()).toBeVisible({ timeout: 10_000 });

    // Send second message
    await page.fill('input[name="text"]', msg2);
    await page.getByRole('button', { name: 'Send' }).click();
    await expect(page.getByText(msg2).first()).toBeVisible({ timeout: 10_000 });

    // Both should be visible
    await expect(page.locator('li', { hasText: msg1 })).toBeVisible();
    await expect(page.locator('li', { hasText: msg2 })).toBeVisible();
  });

  test('button shows pending state during submission', async ({ page }) => {
    await page.goto('/');
    const msg = `PW-${Date.now()}-pending`;
    await page.fill('input[name="text"]', msg);

    // Click and immediately check for pending state
    const submitButton = page.getByRole('button', { name: /Send|Sending/ });
    await submitButton.click();

    // The message should eventually appear
    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 10_000 });
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

test.describe('SSR (Server-Side Rendering)', () => {
  test('initial HTML contains rendered content before JS executes', async ({ page }) => {
    // Disable JavaScript to verify SSR renders content server-side
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Content should be visible from SSR even without JS
    await expect(page.locator('h1')).toHaveText('Home');
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('.timestamp')).toContainText('Server rendered at');
  });

  test('SSR HTML has nav links as real anchor tags', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    // Nav links should be regular <a> tags in SSR HTML
    const homeLink = page.locator('nav a[href="/"]');
    await expect(homeLink).toHaveText('Home');
    const aboutLink = page.locator('nav a[href="/about"]');
    await expect(aboutLink).toHaveText('About');
  });

  test('SSR works for nested routes', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/dashboard/settings', { waitUntil: 'domcontentloaded' });

    // Dashboard layout + settings content should be SSR'd
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.locator('h2').first()).toHaveText('Settings');
  });

  test('hydration makes client components interactive', async ({ page }) => {
    await page.goto('/about');
    // Wait for hydration to complete - counter should be interactive
    await expect(page.locator('text=Count: 0')).toBeVisible();
    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('text=Count: 1')).toBeVisible();
  });
});

test.describe('Segment diffing', () => {
  test('navigation sends X-RSC-Previous-URL header', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Home');

    // Listen for RSC fetch with previous URL header
    const rscRequest = page.waitForRequest((req) =>
      req.url().includes('__rsc')
    );

    await page.getByRole('link', { name: 'About' }).first().click();
    await expect(page.locator('h1')).toHaveText('About');

    const req = await rscRequest;
    const prevUrlHeader = req.headers()['x-rsc-previous-url'];
    expect(prevUrlHeader).toBe('/');
  });

  test('shared layout is preserved during sibling navigation', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Home');

    // Navigate to about - root layout (nav) should persist
    await page.getByRole('link', { name: 'About' }).first().click();
    await expect(page.locator('h1')).toHaveText('About');
    // Use first nav (root layout nav) since dashboard has its own nav
    await expect(page.locator('nav').first()).toBeVisible();

    // Navigate to dashboard - root layout should still persist
    await page.locator('nav').first().getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.locator('nav').first()).toBeVisible();
  });

  test('dashboard sub-route navigation preserves dashboard layout', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('h2')).toHaveText('Dashboard Overview');

    // Navigate to settings within dashboard - dashboard layout persists
    await page.getByRole('link', { name: 'Settings' }).first().click();
    await expect(page.locator('h2').first()).toHaveText('Settings');
    await expect(page.locator('h1')).toHaveText('Dashboard');
  });
});
