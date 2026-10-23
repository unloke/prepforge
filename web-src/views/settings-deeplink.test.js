import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// A deep link to a block inside a card ("Link Lichess" opens #set-connections,
// which lives in the Account card) opens that card. Scrolling the block itself
// to the top pushed the card's top off the screen, so the scroll spy marked the
// next card down: the link said Account, the strip said Board.
const controller = readFileSync(new URL("./settings-controller.js", import.meta.url), "utf8");
const openSection = controller.slice(
  controller.indexOf("export async function openSettingsSection"),
  controller.indexOf("let settingsActionsPromise"),
);

describe("Settings deep links", () => {
  it("opens the card that holds a block instead of scrolling the block", () => {
    expect(openSection).toContain("closest(\".card[id]\")");
    expect(openSection).toMatch(/settings-nav-link\[href="\#\$\{card\.id\}"\]/);
    expect(openSection).not.toContain("scrollIntoView");
  });

  it("still clicks the strip link when the id is a section", () => {
    expect(openSection).toContain("settings-nav-link[href=\"#${sectionId}\"]");
  });
});
