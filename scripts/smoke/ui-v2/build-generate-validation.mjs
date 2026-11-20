export async function checkGenerateValidation(page, check) {
  const open = async () => {
    await page.locator("#build-menu").click();
    await page.locator('#repertoire-context-menu [data-action="explore"]').click();
    await page.locator('#repertoire-context-menu [data-action="build-generate"]').click();
    const dialog = page.getByRole("dialog", { name: "Generate moves from this position", exact: true });
    await dialog.waitFor();
    await page.waitForTimeout(200);
    return dialog;
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  let reopened = await open();
  await reopened.locator('[name="own_moves"]').fill("0");
  await reopened.locator('[name="own_moves"]').press("Enter");
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
  reopened = await open();
  const reopenedInput = reopened.locator('[name="own_moves"]');
  await reopenedInput.fill("1.5");
  await reopenedInput.press("Enter");
  const currentDescription = await reopenedInput.evaluate((input) => {
    const message = document.getElementById(input.getAttribute("aria-describedby"));
    return !!message && input.closest("dialog").contains(message)
      && message.checkVisibility() && message.textContent === "Use a whole number.";
  });
  check(currentDescription, "reopened Generate input must reference its own visible whole-number error");
  console.log(`[build-generate-description] ${currentDescription ? "ok" : "FAIL"} — reopened input describes its current visible error`);
  await reopened.getByRole("button", { name: "Cancel", exact: true }).click();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    const dialog = await open();
    const fields = dialog.locator('input[type="number"]');
    const defaults = await fields.evaluateAll((inputs) => inputs.map((el) => el.value));
    for (let index = 0; index < await fields.count(); index++) {
      const input = fields.nth(index);
      const { min, max, name } = await input.evaluate((el) => ({ min: Number(el.min), max: Number(el.max), name: el.name }));
      const invalid = [String(min - 1), String(max + 1), "", String(min + 0.5)];
      for (const value of invalid) {
        await input.fill(value);
        await input.press("Enter");
        await page.waitForTimeout(30);
        const stayed = await dialog.evaluate((el) => el.open).catch(() => false);
        check(stayed, `${width}: ${name}=${JSON.stringify(value)} must not start Generate`);
        if (!stayed) {
          console.log("[build-generate-validation] FAIL — invalid value started Generate");
          return;
        }
        check(await input.getAttribute("aria-invalid") === "true", `${width}: ${name} must show an inline error`);
        check(await input.locator("..").locator('[role="alert"]:visible').count() === 1, `${width}: ${name} error must be visible`);
        await input.fill(defaults[index]);
      }
    }
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  const dialog = await open();
  await dialog.locator('[name="own_moves"]').fill("1");
  await dialog.locator('[name="engine_depth"]').fill("1");
  await dialog.locator('[name="maia_rating"]').fill("2377");
  await dialog.getByRole("button", { name: "Generate", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  console.log("[build-generate-validation] ok — all five fields reject low/high/empty/fractional values on desktop + phone; valid submission starts");
}
