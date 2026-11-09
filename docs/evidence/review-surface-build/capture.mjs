// node docs/evidence/review-surface-build/capture.mjs DesignReview 1440
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const state = process.argv[2] ?? 'DesignReview';
const width = Number(process.argv[3] ?? 1440);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width, height: 900 } });
const errors = [];
page.on('pageerror', (error) => {
  if (!error.message.includes('WebSocket')) errors.push(error.message);
});
try {
  await page.goto(`http://127.0.0.1:5180/__fixture?state=${state}`, {
    waitUntil: 'domcontentloaded',
  });
  if (state === 'DesignPropose') {
    await page
      .getByRole('button', { name: 'Propose', exact: true })
      .first()
      .click({ timeout: 60000 });
    await page.getByLabel('What is this?').fill('A way back from a project');
    await page
      .getByLabel('What changed, and why?')
      .fill(
        'Project pages get a breadcrumb back to Projects, and on iPhone a project opens as its own page. Today the only way back is the browser’s Back button.',
      );
  } else if (state !== 'DesignToReview') {
    await page.locator('.dl-rv').waitFor({ timeout: 60000 });
    if (state !== 'loading') {
      await page.locator('.dl-rv-live-surface iframe').last().waitFor({ timeout: 90000 });
      await page.locator('.dl-rv-stage-loading').waitFor({ state: 'hidden', timeout: 30000 });
      if (state === 'DesignReviewWipe' || state === 'DesignReviewWords') {
        if (width <= 820) await page.locator('.dl-rv-pick').click();
        await page
          .getByRole('button', { name: /Projects on iPhone/ })
          .last()
          .click();
        await page.locator('.dl-rv-stage-loading').waitFor({ state: 'hidden' });
      }
      if (['DesignReviewDiff', 'DesignReviewDiffSeveral', 'DesignReviewWipe'].includes(state)) {
        await page
          .getByRole('button', {
            name: state === 'DesignReviewWipe' ? 'Wipe' : 'Overlay',
            exact: true,
          })
          .click();
        await page.getByRole('slider', { name: 'Old to new' }).fill('50');
      }
      if (state === 'DesignReviewWidth') {
        await page.getByRole('slider', { name: 'Screen width' }).focus();
        await page.keyboard.press('Home');
        for (let i = 0; i < (width > 820 ? 49 : 20); i++) await page.keyboard.press('ArrowRight');
      }
      if (state === 'DesignReviewNew') {
        if (width <= 820) await page.locator('.dl-rv-pick').click();
        await page
          .getByRole('button', { name: /A project on iPhone/ })
          .last()
          .click();
      }
      if (state === 'DesignReviewNote')
        await page
          .getByRole('button', { name: 'Send 1 note', exact: true })
          .filter({ visible: true })
          .click();
      if (state === 'DesignReviewApproveCheck')
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .filter({ visible: true })
          .click();
      if (state === 'DesignReviewRegion' || state === 'DesignReviewDraw') {
        await page
          .getByRole('button', {
            name: state === 'DesignReviewRegion' ? 'Mark an area' : 'Draw',
            exact: true,
          })
          .click();
        const box = await page.locator('.dl-rv-live-surface').boundingBox();
        await page.mouse.move(box.x + 45, box.y + 90);
        await page.mouse.down();
        await page.mouse.move(box.x + 270, box.y + 155, { steps: 20 });
        await page.mouse.up();
        await page
          .getByRole('textbox', { name: 'Note', exact: true })
          .fill('Keep the project name bold.');
      }
      await page.waitForTimeout(250);
    }
  } else await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  mkdirSync('output/review-surface', { recursive: true });
  const path = `output/review-surface/${state}-${width}.png`;
  await page.screenshot({ path });
  console.log(
    JSON.stringify({
      path,
      url: page.url(),
      errors,
      text: (await page.locator('body').innerText()).slice(0, 2500),
    }),
  );
} finally {
  await browser.close();
}
