import { test, expect } from '@playwright/test';

// ===========================================
// Dev SSR - HTML rendered without JavaScript
// ===========================================

test.describe('Dev SSR', () => {
  test('home page SSR renders content without JS', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('h1')).toHaveText('Home');
    await expect(page.locator('nav')).toBeVisible();
    await expect(page.locator('text=Server rendered at')).toBeVisible();
  });

  test('about page SSR renders server and client components', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/about', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('h1')).toHaveText('About');
    await expect(page.locator('text=Server rendered at')).toBeVisible();
    await expect(page.locator('text=Count: 0')).toBeVisible();
  });

  test('nested routes SSR render correctly', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/dashboard/settings', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.locator('h2').first()).toHaveText('Settings');
  });

  test('SSR HTML has nav links as real anchor tags', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    await expect(page.locator('nav a[href="/"]')).toHaveText('Home');
    await expect(page.locator('nav a[href="/about"]')).toHaveText('About');
    await expect(page.locator('nav a[href="/dashboard"]')).toHaveText('Dashboard');
    await expect(page.locator('nav a[href="/posts"]')).toHaveText('Blog');
  });
});

// ===========================================
// Dev CSS
// ===========================================

test.describe('Dev CSS', () => {
  test('CSS link tag is present in SSR HTML', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded' });

    const cssLink = page.locator('link[rel="stylesheet"][href="/app/styles.css"]');
    await expect(cssLink).toHaveCount(1);
  });

  test('Tailwind styles are applied', async ({ page }) => {
    await page.goto('/');
    // nav has bg-gray-100 class — should have a visible background
    const nav = page.locator('nav').first();
    await expect(nav).toBeVisible();
    const bgColor = await nav.evaluate((el) => getComputedStyle(el).backgroundColor);
    // bg-gray-100 = rgb(243, 244, 246) — just verify it's not transparent
    expect(bgColor).not.toBe('rgba(0, 0, 0, 0)');
    expect(bgColor).not.toBe('transparent');
  });
});

// ===========================================
// Hydration
// ===========================================

test.describe('Hydration', () => {
  test('counter on about page hydrates and increments', async ({ page }) => {
    await page.goto('/about');
    await expect(page.locator('text=Count: 0')).toBeVisible();

    // Wait for hydration — in dev mode, modules load individually so it takes longer
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('text=Count: 1')).toBeVisible();

    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('text=Count: 2')).toBeVisible();
  });

  test('counter on dashboard settings hydrates', async ({ page }) => {
    await page.goto('/dashboard/settings');
    await expect(page.locator('text=Count: 0')).toBeVisible();

    // Wait for hydration — in dev mode, modules load individually so it takes longer
    await page.waitForLoadState('networkidle');

    await page.getByRole('button', { name: 'Increment' }).click();
    await expect(page.locator('text=Count: 1')).toBeVisible();
  });
});

// ===========================================
// Client-side navigation
// ===========================================

test.describe('Client-side navigation', () => {
  test('navigate to About page via Link', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('link', { name: 'About' }).first().click();
    await expect(page.locator('h1')).toHaveText('About');
    await expect(page.locator('text=Server rendered at')).toBeVisible();
  });

  test('navigate to Dashboard page via Link', async ({ page }) => {
    await page.goto('/');
    await page.locator('nav').first().getByRole('link', { name: 'Dashboard' }).click();
    await expect(page.locator('h1')).toHaveText('Dashboard');
    await expect(page.locator('h2')).toHaveText('Dashboard Overview');
  });

  test('navigate between dashboard sub-routes', async ({ page }) => {
    await page.goto('/dashboard');
    await expect(page.locator('h2')).toHaveText('Dashboard Overview');

    await page.getByRole('link', { name: 'Settings' }).first().click();
    await expect(page.locator('h2').first()).toHaveText('Settings');

    await page.getByRole('link', { name: 'Overview' }).click();
    await expect(page.locator('h2')).toHaveText('Dashboard Overview');
  });

  test('RSC endpoint is fetched during navigation', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('h1')).toHaveText('Home');

    // Wait for hydration so Link click handlers are active
    await page.waitForLoadState('networkidle');

    const [req] = await Promise.all([
      page.waitForRequest((req) => req.url().includes('__rsc')),
      page.getByRole('link', { name: 'About' }).first().click(),
    ]);

    await expect(page.locator('h1')).toHaveText('About');
    expect(req.url()).toContain('__rsc');
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

// ===========================================
// Server actions
// ===========================================

test.describe('Server actions', () => {
  test('submit a message via MessageBoard', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('text=Server Action Demo')).toBeVisible();

    const msg = `PW-DEV-${Date.now()}-submit`;
    await page.fill('input[name="text"]', msg);
    await page.getByRole('button', { name: 'Send' }).click();

    await expect(page.getByText(msg).first()).toBeVisible({ timeout: 10_000 });
  });
});

// ===========================================
// Direct URL access
// ===========================================

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

// ===========================================
// Dynamic routes
// ===========================================

test.describe('Dynamic routes', () => {
  test('posts list page renders', async ({ page }) => {
    await page.goto('/posts');
    await expect(page.locator('h1')).toHaveText('Blog');
    await expect(page.locator('h2').first()).toHaveText('Recent Posts');
    await expect(page.locator('ul li').first()).toBeVisible();
  });

  test('post detail page renders', async ({ page }) => {
    await page.goto('/posts/1');
    await expect(page.locator('h1')).toHaveText('Blog');
    await expect(page.locator('article h2')).toBeVisible();
    await expect(page.locator('h3', { hasText: 'Comments' })).toBeVisible();
  });

  test('user profile page renders', async ({ page }) => {
    await page.goto('/users/1');
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('text=Email:')).toBeVisible();
    await expect(page.locator('text=Phone:')).toBeVisible();
  });

  test('navigate from posts list to detail', async ({ page }) => {
    await page.goto('/posts');
    await expect(page.locator('h1')).toHaveText('Blog');

    await page.locator('a[href="/posts/1"]').first().click();
    await expect(page.locator('article h2')).toBeVisible();
    await expect(page.locator('h1')).toHaveText('Blog');
  });
});

// ===========================================
// Dynamic routes - SSR
// ===========================================

test.describe('Dynamic routes SSR', () => {
  test('posts list is SSR rendered', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/posts', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Blog');
    await expect(page.locator('ul li').first()).toBeVisible();
  });

  test('post detail is SSR rendered', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/posts/1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toHaveText('Blog');
    await expect(page.locator('article h2')).toBeVisible();
  });

  test('user profile is SSR rendered', async ({ page }) => {
    await page.route('**/*.js', (route) => route.abort());
    await page.goto('/users/1', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('text=Email:')).toBeVisible();
  });
});
