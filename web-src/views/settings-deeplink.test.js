import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// A deep link to a block inside a card ("Link Lichess" opens #set-connections,
// which lives in the Account card) opens that card's area. Each card names its
// area in data-area, and the nav link for that area is the one that is clicked.
const controller = readFileSync(new URL("./settings-controller.js", import.meta.url), "utf8");
const openSection = controller.slice(
  controller.indexOf("export async function openSettingsSection"),
  controller.indexOf("let settingsActionsPromise"),
);

describe("Settings deep links", () => {
  it("opens the area that holds a block instead of scrolling the block", () => {
    expect(openSection).toContain('closest("[data-area]")');
    expect(openSection).toContain("settings-nav-link[data-area=\"${area}\"]");
    expect(openSection).not.toContain("scrollIntoView");
  });
});
