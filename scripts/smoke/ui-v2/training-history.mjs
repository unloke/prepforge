import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { strict as assert } from 'node:assert';

// One completed Smart queue fixture run, plus a seeded document for the list.
const historyKey = (owner) => `pf.trainHistory:${encodeURIComponent(owner)}`;
const seededRuns = [
  { id: 's1:2026-10-21T07:00:00+00:00', mode: 'blitz', repertoires: ['Caro-Kann: Advance', 'London System'],
    startedAt: '2026-10-21T07:00:00+00:00', finishedAt: '2026-10-21T07:12:00.000Z', cards: 12, correct: 9, mistakes: 2, skipped: 1 },
  { id: 's2:2026-10-19T18:00:00+00:00', mode: 'smart', repertoires: ['A repertoire with a very long name that has to wrap or truncate: Najdorf, English Attack, and the whole family'],
    startedAt: '2026-10-19T18:00:00+00:00', finishedAt: '2026-10-19T18:34:00.000Z', cards: 36, correct: 24, mistakes: 9, skipped: 3 },
  { id: 's3:2026-10-17T09:00:00+00:00', mode: 'smart', repertoires: ['London System'],
    startedAt: '2026-10-17T09:00:00+00:00', finishedAt: '2026-10-17T09:08:00.000Z', cards: 8, correct: 0, mistakes: 0, skipped: 8 },
  ...Array.from({ length: 104 }, (_, index) => ({
    id: `s${index + 10}:2026-09-${String((index % 28) + 1).padStart(2, '0')}T10:00:00+00:00`, mode: 'smart',
    repertoires: ['Caro-Kann: Advance'], startedAt: '2026-09-01T10:00:00+00:00',
    finishedAt: new Date(Date.UTC(2026, 8, 1, 10) + index * 3600000).toISOString(),
    cards: 20, correct: 15, mistakes: 4, skipped: 1,
  })),
];

export async function checkTrainingHistory(page, check, shot) {
  await page.locator('#train-summary [data-train-history]').click();
  await page.locator('#training-history-dialog .th-lead').waitFor();
  const cards = await page.locator('#training-history-dialog [data-history-cards]').textContent();
  check(cards.trim() === '4', `history must record the four cards actually completed, got ${cards}`);
  const firstTry = await page.locator('#training-history-dialog [data-history-first-try]').textContent();
  check(firstTry.trim() === '100%', `first-try figure must come from run counters, got ${firstTry}`);
  check(await page.locator('#training-history-dialog .th-run').count() === 0, 'a first completion has no earlier runs');
  check((await page.locator('#training-history-title').textContent()) === 'Training history', 'history must name itself');
  check((await page.locator('#training-history-dialog .th-scope').textContent()).includes('this browser'), 'history must say it is stored in this browser');
  const foot = await page.locator('#training-history-dialog .th-foot').textContent();
  check(/^1 saved run$/.test(foot.trim()), `history must report the count it actually holds, got "${foot}"`);
  const footNote = await page.locator('#training-history-dialog .th-foot span').getAttribute('title');
  check(/^Keeps up to \d+ recent runs within \d+ KiB in this browser$/.test(footNote || ''), `the retention detail belongs in the footer tooltip, got "${footNote}"`);
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
    await reopened.locator('#view-train [data-train-history]:visible').first().waitFor({ state: 'visible' });
    await reopened.locator('#view-train [data-train-history]:visible').first().click();
    await reopened.locator('#training-history-dialog .th-lead').waitFor();
    assert.equal(await reopened.locator('#training-history-dialog .th-lead').count(), 1, 'history must survive opening a new app page');
    await reopened.keyboard.press('Escape');

    // The capped list: 107 seeded runs render as the newest lead plus a bounded
    // earlier list, long names clamp instead of pushing the dialog sideways.
    const seed = await reopened.evaluate(({ key, runs }) => {
      localStorage.setItem(key, JSON.stringify({ v: 1, runs }));
      return localStorage.getItem(key).length;
    }, { key: historyKey('u1'), runs: seededRuns });
    assert.ok(seed > 0, 'seed must be written');
    await reopened.reload({ waitUntil: 'domcontentloaded' });
    await reopened.locator('#view-train [data-train-history]:visible').first().waitFor({ state: 'visible' });
    await reopened.locator('#view-train [data-train-history]:visible').first().click();
    await reopened.locator('#training-history-dialog .th-lead').waitFor();
    const listed = await reopened.locator('#training-history-dialog .th-run').count();
    assert.ok(listed < 107, `the list must be bounded, got ${listed}`);
    const manyFoot = (await reopened.locator('#training-history-dialog .th-foot').textContent()).trim();
    assert.ok(/^\d+ saved runs?$/.test(manyFoot), `the footer must report the saved count, got "${manyFoot}"`);
    assert.ok(listed > 5, `earlier runs must be listed, got ${listed}`);
    const scrolls = await reopened.evaluate(() => {
      const body = document.querySelector('#training-history-dialog .th-body');
      return body.scrollHeight - body.clientHeight;
    });
    assert.ok(scrolls > 0, 'a long list scrolls inside the dialog, not the page');
    const listName = await reopened.locator('#training-history-dialog .th-run .th-name').nth(0).evaluate((el) => ({
      lines: Math.round(el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight)),
      scrolls: el.scrollWidth - el.clientWidth,
    }));
    assert.ok(listName.lines <= 2 && listName.scrolls <= 1, `a long name must clamp, got ${JSON.stringify(listName)}`);
    const listOverflow = await reopened.evaluate(() => {
      const dialog = document.querySelector('#training-history-dialog .modal');
      const box = dialog.getBoundingClientRect();
      return { horizontal: dialog.scrollWidth - dialog.clientWidth, right: innerWidth - box.right, left: box.left };
    });
    assert.ok(listOverflow.horizontal <= 1 && listOverflow.left >= 0 && listOverflow.right >= 0, `a full list must stay inside the viewport: ${JSON.stringify(listOverflow)}`);
    if (process.env.UI_V2_SHOTS) {
      await reopened.mouse.move(2, 2);
      await reopened.waitForTimeout(250);
      await reopened.screenshot({ path: join(process.env.UI_V2_SHOTS, `history-many-${process.env.UI_V2_TAG || 'after'}.png`) });
    }
  } finally { await reopened.close(); }
}
