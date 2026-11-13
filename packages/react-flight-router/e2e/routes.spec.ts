import { test, expect } from 'playwright/test';

test('a declared redirect is a real HTTP redirect on a document request', async ({ request }) => {
  const response = await request.get('/old/7?from=bookmark', { maxRedirects: 0 });
  expect(response.status()).toBe(308);
  expect(response.headers()['location']).toBe('http://127.0.0.1:5304/photos/7?from=bookmark');
});

test('client navigation follows a declared redirect and keeps the fragment', async ({ page }) => {
  await page.goto('/links');
  await page.waitForFunction(() => Boolean((window as any).__RFR_METRICS__));
  await page.getByRole('link', { name: 'Old photo' }).click();
  await expect(page.getByRole('heading', { name: 'Committed photo' })).toBeVisible();
  await expect(page).toHaveURL('http://127.0.0.1:5304/photos/7?from=links#part');
  // Replaced, not pushed: going back skips the redirect source.
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Links' })).toBeVisible();
});

test('a "use client" route component renders on the server and hydrates', async ({ page }) => {
  const response = await page.goto('/counter?tab=a');
  expect(response!.status()).toBe(200);
  expect(await response!.text()).toMatch(/<button>Clicked (<!-- -->)?0<\/button>/);
  await expect(page.locator('#props')).toHaveText('{"params":{},"searchParams":{"tab":"a"}}');
  await page.getByRole('button', { name: 'Clicked 0' }).click();
  await expect(page.getByRole('button', { name: 'Clicked 1' })).toBeVisible();
});
