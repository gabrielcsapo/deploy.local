import assert from 'node:assert/strict';
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto('http://127.0.0.1:5180/__fixture?state=DesignReview');
  await page.locator('.dl-rv-stage-loading').waitFor({ state: 'hidden' });
  await page.locator('.dl-rv-live-surface iframe').last().waitFor();
  await page.getByText('1 of 4 looked at', { exact: true }).first().waitFor();
  assert.equal(await page.locator('.dl-rv-live-surface iframe').count(), 2);
  assert.equal(
    await page.locator('.dl-rv-live-surface iframe').first().getAttribute('sandbox'),
    'allow-same-origin',
  );
  assert.equal(await page.locator('.dl-app > .dl-side').isVisible(), false);
  const frame = page.frameLocator('iframe[title$="New"]');
  const target = await frame.locator('[data-layer="home-gym"]').boundingBox();
  await page.getByRole('button', { name: 'Pin a point', exact: true }).click();
  await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Keep this name bold.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page
    .getByRole('button', { name: 'Send 1 note', exact: true })
    .filter({ visible: true })
    .waitFor();
  const item = new URL(page.url()).searchParams.get('item');
  const api = 'http://127.0.0.1:5180/api/v2/projects/review-project/design';
  const review = await (await fetch(`${api}/review?item=${encodeURIComponent(item)}`)).json();
  assert.equal(review.pins[0].layer, 'home-gym');
  assert.ok(Math.abs(review.pins[0].offset.x - 0.5) < 0.05);
  const grip = page.getByRole('slider', { name: 'Screen width' });
  await grip.focus();
  await page.keyboard.press('Home');
  for (let n = 0; n < 32; n++) await page.keyboard.press('ArrowRight');
  assert.equal(await grip.getAttribute('aria-valuenow'), '640');
  await page
    .getByRole('button', { name: 'Approve', exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole('button', { name: 'Approve anyway', exact: true }).click();
  await page
    .getByText(/Approved · goes to main in/)
    .filter({ visible: true })
    .waitFor();
  await page.getByRole('button', { name: 'Undo', exact: true }).filter({ visible: true }).click();
  await page
    .getByRole('button', { name: 'Send 1 note', exact: true })
    .filter({ visible: true })
    .waitFor();
  assert.equal(
    (await (await fetch(`${api}/review?item=${encodeURIComponent(item)}`)).json()).item.state,
    'waiting',
  );
  await page.getByRole('button', { name: 'Mark an area', exact: true }).click();
  const surface = await page.locator('.dl-rv-live-surface').boundingBox();
  await page.mouse.move(surface.x + 30, surface.y + 90);
  await page.mouse.down();
  await page.mouse.move(surface.x + 230, surface.y + 140, { steps: 10 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Give this area room.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page
    .getByRole('button', { name: 'Send 2 notes', exact: true })
    .filter({ visible: true })
    .waitFor();
  const withArea = await (await fetch(`${api}/review?item=${encodeURIComponent(item)}`)).json();
  assert.equal(withArea.pins[1].width, 640);
  assert.equal(withArea.pins[1].area.w, 200);
  await page.getByRole('button', { name: 'Draw', exact: true }).click();
  await page.mouse.move(surface.x + 40, surface.y + 220);
  await page.mouse.down();
  await page.mouse.move(surface.x + 220, surface.y + 260, { steps: 12 });
  await page.mouse.up();
  await page.getByRole('textbox', { name: 'Note', exact: true }).fill('Keep these together.');
  await page.getByRole('button', { name: 'Save note', exact: true }).click();
  await page
    .getByRole('button', { name: 'Send 3 notes', exact: true })
    .filter({ visible: true })
    .waitFor();
  const drawn = await (await fetch(`${api}/review?item=${encodeURIComponent(item)}`)).json();
  assert.equal(drawn.pins[2].drawing.nativeWidth, 640);
  assert.ok(drawn.pins[2].drawing.strokes[0].length > 2);
  await page.getByRole('button', { name: 'Wipe', exact: true }).click();
  await page.getByRole('slider', { name: 'Old to new' }).fill('50');
  assert.equal(
    await page.getByRole('slider', { name: 'Wipe divider' }).getAttribute('aria-valuenow'),
    '50',
  );
  await page.reload();
  await page.getByRole('button', { name: 'Wipe', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: 'Wipe', exact: true }).getAttribute('aria-pressed'),
    'true',
  );
  await page.setViewportSize({ width: 700, height: 900 });
  assert.equal(await page.locator('.dl-rv-rail').isVisible(), false);
  assert.equal(await page.locator('.dl-rv-bottom').isVisible(), true);
  await page.locator('.dl-rv-pick').click();
  await page
    .getByRole('button', { name: /A project on iPhone/ })
    .last()
    .click();
  await page.getByText('New screen · nothing to compare', { exact: true }).waitFor();
  assert.equal(await page.locator('.dl-rv-live-surface iframe').count(), 1);
  assert.equal(await page.locator('.dl-rv-frame').evaluate((el) => el.clientWidth), 390);
  await page
    .getByRole('button', { name: 'Send 3 notes', exact: true })
    .filter({ visible: true })
    .click();
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page
    .getByText(/3 notes sent to Designer/)
    .filter({ visible: true })
    .waitFor();
  const sent = await (await fetch(`${api}/review?item=${encodeURIComponent(item)}`)).json();
  assert.equal(sent.item.answer.actionId, 'changes');
  await page.keyboard.press('Escape');
  await page.waitForURL('**/dashboard/design?view=review');
  await page.goto('http://127.0.0.1:5180/__fixture?state=DesignPropose');
  await page.getByRole('button', { name: 'Propose', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Propose for review' });
  assert.equal(
    await dialog.getByRole('button', { name: 'Propose', exact: true }).isDisabled(),
    true,
  );
  await page.getByLabel('What is this?').fill('A way back from a project');
  assert.equal(
    await dialog.getByRole('button', { name: 'Propose', exact: true }).isDisabled(),
    true,
  );
  await page
    .getByLabel('What changed, and why?')
    .fill('Add a breadcrumb so people can get back to Projects.');
  await dialog.getByRole('button', { name: 'Propose', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  const proposed = await (await fetch('http://127.0.0.1:5180/api/v2/design/reviews')).json();
  assert.equal(
    proposed.proposals[0].summary,
    'Add a breadcrumb so people can get back to Projects.',
  );
  console.log(
    'Passed: focus mode, grouped seen state, anchored point/area/drawing notes, sending notes, required proposal fields, arbitrary width, approve check, durable Undo, remembered Wipe, compact layout and new phone screen.',
  );
} finally {
  await browser.close();
}
