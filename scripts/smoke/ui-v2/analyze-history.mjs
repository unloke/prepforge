// A native details toggle queues a task. Its old rows can still say
// aria-busy=false after opening, before that task starts the refresh.
export async function openAnalysisHistory(page) {
  const button = page.locator('#view-analyze [data-sheet-open="analyze-open"]');
  if (await button.isVisible() && (await button.getAttribute("aria-expanded")) !== "true") await button.click();
  const drawer = page.locator("#history-drawer");
  if (!await drawer.evaluate((d) => d.open)) {
    // Arm before opening: observing old ready rows is not sufficient. Wait for
    // the refresh triggered by this opening, then for its render to finish.
    const refreshed = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/api/analyses" && response.request().method() === "GET",
    { timeout: 10000 });
    const reveal = page.locator('#analyze-open [data-reveal="#history-drawer"]');
    await Promise.all([refreshed, (async () => {
      if (await reveal.isVisible()) await reveal.click();
      else await drawer.evaluate((d) => { d.open = true; });
    })()]);
  }
  await page.waitForFunction(() =>
    document.querySelector('#analysis-history[aria-busy="false"] .history-item[data-game-id]'),
  null, { timeout: 10000 });
}
