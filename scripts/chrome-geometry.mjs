import { chromium } from 'playwright';

// Chrome geometry contract (see prototype/HANDOFF.md):
//  - desktop: the 60px rail overlays to 204px on hover/keyboard focus and must
//    never move main content or the board;
//  - there is no desktop top bar: search and theme live in the rail foot, and
//    notifications stack bottom-right; a long one wraps fully without
//    clipping or shifting the chrome around it;
//  - mobile (390): bottom tab bar with 44px targets, no horizontal scroll.
const DESKTOP_WIDTHS = [1024, 1180, 1200, 1440];
const MOBILE_WIDTH = 390;

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
try {
  for (const viewportWidth of DESKTOP_WIDTHS) {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: 900 } });
    await page.goto(process.env.PREPFORGE_URL || 'http://127.0.0.1:5173/static/');
    await page.waitForTimeout(1000);
    // Park the virtual pointer over the workspace before measuring the
    // baseline: headless Chromium applies :hover at the mouse's default
    // (0,0) position, which sits on the fixed rail and would measure the
    // overlay-expanded 204px instead of the collapsed 60px track.
    await page.mouse.move(Math.round(viewportWidth / 2), 450);
    await page.evaluate(() => document.activeElement instanceof HTMLElement
      && document.activeElement.blur());
    await page.waitForTimeout(300);
    const snapshot = () => page.evaluate(() => {
      const rect = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      const card = document.querySelector('#notices .notice');
      const text = card?.querySelector('.notice-text');
      return {
        hasTopbar: document.querySelector('.topbar') !== null, main: rect('.workspace'),
        rail: rect('#app-rail'),
        palette: rect('#open-palette'),
        account: rect('#theme-toggle'),
        status: card ? rect('#notices .notice') : null,
        statusScrollWidth: text?.scrollWidth,
        statusClientWidth: text?.clientWidth,
      };
    });
    const before = await snapshot();
    if (before.hasTopbar || before.main.y !== 0) {
      throw new Error(`${viewportWidth}px should have no top bar above the workspace: ${JSON.stringify(before.main)}`);
    }
    await page.evaluate(async () => {
      const { createNotices } = await import('/static/notices.js');
      window.__notices = createNotices();
      window.__notices.bind(document.getElementById('notices'));
      window.__notices.status('A long repertoire status message '.repeat(10));
    });
    await page.waitForTimeout(300);
    const long = await snapshot();
    await page.evaluate(() => window.__notices.status(''));
    await page.waitForTimeout(400);
    const cleared = await snapshot();
    for (const key of ['main', 'palette', 'account']) {
      for (const coordinate of ['x', 'y', 'width', 'height']) {
        if (before[key][coordinate] !== long[key][coordinate]
            || before[key][coordinate] !== cleared[key][coordinate]) {
          throw new Error(`${key}.${coordinate} shifted`);
        }
      }
    }
    if (!long.status || long.status.height <= 40 || long.status.width > 360
        || long.statusScrollWidth > long.statusClientWidth || cleared.status) {
      throw new Error(`Long notice must wrap without clipping, then clear: ${JSON.stringify({ long, cleared })}`);
    }
    // The stack sits in the bottom-right corner, clear of the rail.
    if (long.status.x < long.rail.x + long.rail.width + 8
        || long.status.x + long.status.width > viewportWidth
        || long.status.y < 900 / 2) {
      throw new Error(`${viewportWidth}px notice is out of its corner: ${JSON.stringify(long.status)}`);
    }

    // Rail contract: an icon rail, 60px wide, that stays 60px under the pointer
    // and under keyboard focus, so nothing beside it moves. Each destination
    // carries its name for assistive tech and the tooltip.
    if (before.rail.width !== 60) {
      throw new Error(`${viewportWidth}px rail track is ${before.rail.width}px, expected 60px`);
    }
    const unnamed = await page.locator('#app-rail .nav-item').evaluateAll((els) => els.filter((el) => !el.getAttribute('aria-label')).length);
    if (unnamed) throw new Error(`${viewportWidth}px rail has ${unnamed} destinations without a name`);
    await page.locator('#app-rail').hover();
    await page.waitForTimeout(300);
    const hovered = await snapshot();
    await page.mouse.move(viewportWidth - 5, 5);
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement?.closest('#app-rail') !== null)) break;
    }
    await page.waitForTimeout(300);
    const focused = await snapshot();
    for (const [state, snap] of [['hover', hovered], ['focus', focused]]) {
      if (snap.rail.width !== 60) {
        throw new Error(`${viewportWidth}px rail changed width on ${state}: ${JSON.stringify(snap.rail)}`);
      }
      for (const coordinate of ['x', 'y', 'width', 'height']) {
        if (before.main[coordinate] !== snap.main[coordinate]) {
          throw new Error(`${viewportWidth}px rail ${state} moved main.${coordinate}`);
        }
      }
    }
    console.log(JSON.stringify({ viewportWidth, before, long, cleared, hoveredRail: hovered.rail.width, focusedRail: focused.rail.width }));
    await page.close();
  }

  // Mobile: bottom tab bar, 44px targets, no horizontal scroll, no rail.
  const mobile = await browser.newPage({ viewport: { width: MOBILE_WIDTH, height: 844 } });
  await mobile.goto(process.env.PREPFORGE_URL || 'http://127.0.0.1:5173/static/');
  await mobile.waitForTimeout(1000);
  await mobile.mouse.move(Math.round(MOBILE_WIDTH / 2), 400);
  await mobile.waitForTimeout(300);
  const mobileCheck = await mobile.evaluate(() => {
    const tabbar = document.querySelector('#app-tabbar');
    const items = [...tabbar.querySelectorAll('.tabbar-item')].map((el) => {
      const { width, height } = el.getBoundingClientRect();
      return { width, height };
    });
    return {
      tabbarVisible: getComputedStyle(tabbar).display !== 'none',
      itemCount: items.length,
      items,
      railHidden: getComputedStyle(document.querySelector('#app-rail')).display === 'none',
      hasTopbar: document.querySelector('.topbar') !== null,
      workspaceTop: document.querySelector('.workspace').getBoundingClientRect().y,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  if (!mobileCheck.tabbarVisible || mobileCheck.itemCount !== 5) {
    throw new Error(`390px bottom tab bar wrong: ${JSON.stringify(mobileCheck)}`);
  }
  if (mobileCheck.hasTopbar || mobileCheck.workspaceTop !== 0) {
    throw new Error(`390px should have no top bar above the workspace: ${JSON.stringify(mobileCheck)}`);
  }
  if (!mobileCheck.railHidden) {
    throw new Error('390px rail should be hidden');
  }
  if (mobileCheck.scrollWidth > MOBILE_WIDTH) {
    throw new Error(`390px horizontal overflow: ${mobileCheck.scrollWidth}px`);
  }
  for (const item of mobileCheck.items) {
    if (item.height < 44 || item.width < 44) {
      throw new Error(`390px tab target under 44px: ${JSON.stringify(item)}`);
    }
  }
  console.log(JSON.stringify({ viewportWidth: MOBILE_WIDTH, mobileCheck }));
  await mobile.close();
} finally {
  await browser.close();
}
