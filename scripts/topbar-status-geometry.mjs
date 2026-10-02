import { chromium } from 'playwright';

// Chrome geometry contract (see prototype/HANDOFF.md):
//  - desktop: the 60px rail overlays to 204px on hover/keyboard focus and must
//    never move main content or the board;
//  - there is no desktop top bar: search and theme live in the rail foot, and
//    status messages float as a bottom-right pill; long messages wrap fully
//    without clipping or shifting the chrome around them;
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
      const status = document.querySelector('#app-status');
      return {
        hasTopbar: document.querySelector('.topbar') !== null, main: rect('.workspace'),
        rail: rect('#app-rail'),
        palette: rect('#open-palette'),
        account: rect('#theme-toggle'), status: rect('#app-status'),
        statusScrollWidth: status.scrollWidth,
        statusScrollHeight: status.scrollHeight,
        statusClientHeight: status.clientHeight,
        statusWhiteSpace: getComputedStyle(status).whiteSpace,
        statusOverflow: getComputedStyle(status).textOverflow,
      };
    });
    const before = await snapshot();
    if (before.hasTopbar || before.main.y !== 0) {
      throw new Error(`${viewportWidth}px should have no top bar above the workspace: ${JSON.stringify(before.main)}`);
    }
    await page.locator('#app-status').evaluate((element) => {
      element.textContent = 'A long repertoire status message '.repeat(10);
      element.classList.add('is-fresh');
      element.dataset.state = 'ready';
      element.dataset.severity = 'info';
      document.querySelector('#app-status-close').hidden = true;
      document.querySelector('#topbar-status-slot').classList.remove('is-idle');
    });
    const long = await snapshot();
    await page.locator('#app-status').evaluate((element) => {
      element.textContent = '';
      element.classList.remove('is-fresh');
      document.querySelector('#topbar-status-slot').classList.add('is-idle');
    });
    const cleared = await snapshot();
    for (const key of ['main', 'palette', 'account']) {
      for (const coordinate of ['x', 'y', 'width', 'height']) {
        if (before[key][coordinate] !== long[key][coordinate]
            || before[key][coordinate] !== cleared[key][coordinate]) {
          throw new Error(`${key}.${coordinate} shifted`);
        }
      }
    }
    if (long.status.height <= 20 || long.status.width > 420
        || long.statusScrollWidth > Math.ceil(long.status.width)
        || long.statusScrollHeight > long.statusClientHeight
        || long.statusWhiteSpace !== 'normal' || long.statusOverflow !== 'clip') {
      throw new Error(`Long status must wrap without clipping: ${JSON.stringify(long)}`);
    }
    // The pill floats in the bottom-right corner, clear of the rail.
    if (long.status.x < long.rail.x + long.rail.width + 8
        || long.status.x + long.status.width > viewportWidth
        || long.status.y < 900 / 2) {
      throw new Error(`${viewportWidth}px status pill is out of its corner: ${JSON.stringify(long.status)}`);
    }

    // Rail contract: collapsed width is the 60px track; hover expands to the
    // 204px overlay without moving the topbar, main content, or the board.
    if (before.rail.width !== 60) {
      throw new Error(`${viewportWidth}px rail track is ${before.rail.width}px, expected 60px`);
    }
    await page.locator('#app-rail').hover();
    await page.waitForTimeout(300);
    const hovered = await snapshot();
    if (hovered.rail.width < 200) {
      throw new Error(`${viewportWidth}px rail did not overlay-expand on hover: ${JSON.stringify(hovered.rail)}`);
    }
    for (const key of ['main']) {
      for (const coordinate of ['x', 'y', 'width', 'height']) {
        if (before[key][coordinate] !== hovered[key][coordinate]) {
          throw new Error(`${viewportWidth}px rail hover moved ${key}.${coordinate}`);
        }
      }
    }
    // Keyboard focus inside the rail expands it the same way (:focus-visible).
    await page.mouse.move(viewportWidth - 5, 5);
    await page.waitForTimeout(300);
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press('Tab');
      const inRail = await page.evaluate(() => document.activeElement?.closest('#app-rail') !== null);
      if (inRail) break;
    }
    await page.waitForTimeout(300);
    const focused = await snapshot();
    const focusInRail = await page.evaluate(() => document.activeElement?.closest('#app-rail') !== null);
    if (focusInRail && focused.rail.width < 200) {
      throw new Error(`${viewportWidth}px rail did not overlay-expand on keyboard focus`);
    }
    if (focused.rail.width < 200 && focused.rail.width !== 60) {
      throw new Error(`${viewportWidth}px rail in unexpected state: ${JSON.stringify(focused.rail)}`);
    }
    for (const key of ['main']) {
      for (const coordinate of ['x', 'y', 'width', 'height']) {
        if (before[key][coordinate] !== focused[key][coordinate]) {
          throw new Error(`${viewportWidth}px rail focus moved ${key}.${coordinate}`);
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
  if (!mobileCheck.tabbarVisible || mobileCheck.itemCount !== 6) {
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
