import { chromium } from 'playwright';

// Chrome geometry contract (see prototype/HANDOFF.md):
//  - desktop: the 60px rail overlays to 204px on hover/keyboard focus and must
//    never move main content or the board;
//  - the topbar status overlays the free space left of Ctrl K, stays a single
//    ellipsised line, and never shifts the chrome around it;
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
    const snapshot = () => page.evaluate(() => {
      const rect = (selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return { x, y, width, height };
      };
      const status = document.querySelector('#app-status');
      return {
        header: rect('.topbar'), left: rect('.tb-left'), main: rect('.workspace'),
        rail: rect('#app-rail'),
        palette: rect('#open-palette'),
        account: rect('#account-chip'), status: rect('#app-status'),
        statusScrollWidth: status.scrollWidth,
        statusWhiteSpace: getComputedStyle(status).whiteSpace,
        statusOverflow: getComputedStyle(status).textOverflow,
      };
    });
    const before = await snapshot();
    await page.locator('#app-status').evaluate((element) => {
      element.textContent = 'A very long Build status message '.repeat(30);
    });
    const long = await snapshot();
    await page.locator('#app-status').evaluate((element) => { element.textContent = ''; });
    const cleared = await snapshot();
    for (const key of ['header', 'left', 'main', 'palette', 'account']) {
      for (const coordinate of ['x', 'y', 'width', 'height']) {
        if (before[key][coordinate] !== long[key][coordinate]
            || before[key][coordinate] !== cleared[key][coordinate]) {
          throw new Error(`${key}.${coordinate} shifted`);
        }
      }
    }
    if (long.status.height > 20 || long.status.width > 420
        || long.statusScrollWidth <= long.status.width
        || long.statusWhiteSpace !== 'nowrap' || long.statusOverflow !== 'ellipsis') {
      throw new Error('Long status failed single-line ellipsis geometry');
    }
    if (long.status.x < long.left.x + long.left.width + 8) {
      throw new Error(`${viewportWidth}px status overlaps title block: ${JSON.stringify(long)}`);
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
    for (const key of ['header', 'main']) {
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
    for (const key of ['header', 'main']) {
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
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
  if (!mobileCheck.tabbarVisible || mobileCheck.itemCount !== 5) {
    throw new Error(`390px bottom tab bar wrong: ${JSON.stringify(mobileCheck)}`);
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
