// Shared Games/Scout source picker: the inner grid must fit, not just its shell.
export async function checkSourcePicker(page, opener, check) {
  const original = page.viewportSize();
  const fixture = "local_review_fixture";
  const profileUrl = `https://lichess.org/api/user/${fixture}`;
  await page.route(profileUrl, (route) => route.fulfill({
    contentType: "application/json",
    headers: { "access-control-allow-origin": "*", "cross-origin-resource-policy": "cross-origin" },
    body: JSON.stringify({ id: fixture, username: fixture }),
  }));
  const widths = original.width <= 760 ? [original.width, 320] : [original.width];
  for (const width of [...new Set(widths)]) {
    await page.setViewportSize({ width, height: original.height });
    for (const reducedMotion of ["no-preference", "reduce"]) {
      await page.emulateMedia({ reducedMotion });
      const label = `source picker ${width}px ${reducedMotion}`;
      const trigger = page.locator(opener);
      await trigger.click();
      const picker = page.locator(".src-popover");
      await picker.waitFor({ state: "visible" });
      const input = picker.locator("[data-src-add]");
      await input.fill(fixture);
      await picker.locator("[data-src-add-btn]").click();
      const added = picker.locator(`[data-src-external="${fixture}"]`);
      await added.waitFor({ state: "visible" });
      const geometry = await picker.evaluate((el) => {
        const box = el.getBoundingClientRect();
        return {
          width: el.clientWidth, scrollWidth: el.scrollWidth,
          left: box.left, right: box.right, viewport: innerWidth,
          lists: [...el.querySelectorAll(".src-rows")].map((list) => ({
            width: list.clientWidth, scrollWidth: list.scrollWidth,
            height: list.clientHeight, scrollHeight: list.scrollHeight,
          })),
          controls: [...el.querySelectorAll(".src-head, .src-add-row, input, button")].map((child) => {
            const rect = child.getBoundingClientRect();
            return { name: child.className, left: rect.left, right: rect.right, width: rect.width };
          }),
        };
      });
      check(geometry.scrollWidth <= geometry.width + 1, `${label}: no internal horizontal scroll (${geometry.scrollWidth}/${geometry.width})`);
      check(geometry.left >= 7 && geometry.right <= geometry.viewport - 7, `${label}: shell stays inside viewport`);
      for (const list of geometry.lists) {
        check(list.scrollWidth <= list.width + 1 && list.scrollHeight <= list.height + 1,
          `${label}: short populated list has no clipping (${JSON.stringify(list)})`);
      }
      for (const control of geometry.controls) {
        check(control.width > 0 && control.left >= geometry.left && control.right <= geometry.right,
          `${label}: ${control.name} stays inside picker (${control.left}–${control.right}, picker ${geometry.left}–${geometry.right})`);
      }
      await added.locator(`[data-src-remove-external="${fixture}"]`).click();
      await added.waitFor({ state: "detached" });
      await page.keyboard.press("Escape");
      await picker.waitFor({ state: "detached" });
      check(await trigger.evaluate((el) => document.activeElement === el), `${label}: Escape restores trigger focus`);
      // Done must also be directly clickable without horizontal scrolling.
      await trigger.click();
      await page.locator("[data-src-done]").click();
      await picker.waitFor({ state: "detached" });
      check(await trigger.evaluate((el) => document.activeElement === el), `${label}: Done restores trigger focus`);
    }
  }
  await page.setViewportSize(original);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.unroute(profileUrl);
}
