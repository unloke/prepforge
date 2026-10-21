import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';

export async function checkTrainingHistory(page, check, shot) {
  await page.locator('#train-summary [data-train-history]').click();
  await page.locator('#training-history-dialog .training-history-row').waitFor();
  const cards = await page.locator('#training-history-dialog dd').first().textContent();
  check(cards.trim() === '4', `history must record the four cards actually completed, got ${cards}`);
  check(await page.locator('#training-history-dialog .training-history-row').count() === 1, 'completion must create one history record');
  check((await page.locator('#training-history-title').textContent()) === 'Smart queue history', 'history must name its supported opening-training mode');
  const overflow = await page.evaluate(() => {
    const dialog = document.querySelector('#training-history-dialog .modal');
    const box = dialog.getBoundingClientRect();
    return { horizontal: dialog.scrollWidth - dialog.clientWidth, fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight };
  });
  check(overflow.horizontal <= 1 && overflow.fits, `history must fit the viewport: ${JSON.stringify(overflow)}`);
  await shot('history');
  if (process.env.UI_V2_SHOTS) writeFileSync(join(process.env.UI_V2_SHOTS, 'history-storage.json'), JSON.stringify(await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([key]) => key.startsWith('pf.trainHistory:')))), null, 2));
  await page.keyboard.press('Escape');
  check(await page.locator('#training-history-dialog').count() === 0, 'Escape must close history');
  check(await page.locator('#train-summary [data-train-history]').evaluate(el => document.activeElement === el), 'closing history must restore focus');

  // A second page in the same browser context proves persistence through a new
  // app instance without disturbing the active session in the original page.
  const popup = page.waitForEvent('popup');
  await page.evaluate(() => window.open(location.href, '_blank'));
  const reopened = await popup;
  try {
    await reopened.waitForLoadState('domcontentloaded');
    await reopened.locator('#train-srs-start [data-train-history]').waitFor({ state: 'visible' });
    await reopened.locator('#train-srs-start [data-train-history]').click();
    await reopened.locator('#training-history-dialog .training-history-row').waitFor();
    assert.equal(await reopened.locator('#training-history-dialog .training-history-row').count(), 1, 'history must survive opening a new app page');
  } finally { await reopened.close(); }
}
