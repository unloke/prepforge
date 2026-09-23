import { chromium } from 'playwright';

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROME_PATH || undefined,
});
try {
  for (const viewportWidth of [1024, 1200, 1440]) {
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
      header: rect('.topbar'), nav: rect('.tabs'),
      lastNav: rect('.tabs-primary .tab:last-child'), palette: rect('#open-palette'),
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
  for (const key of ['header', 'nav', 'palette', 'account']) {
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
  if (long.status.x < long.lastNav.x + long.lastNav.width + 8) {
    throw new Error(`${viewportWidth}px status overlaps navigation`);
  }
  console.log(JSON.stringify({ viewportWidth, before, long, cleared }));
  await page.close();
  }
} finally {
  await browser.close();
}
