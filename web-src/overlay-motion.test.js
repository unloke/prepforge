// A menu, a dialog, the command sheet and the phone's More sheet used to switch
// on with no transition at all, which made opening one feel like a page redraw
// rather than a thing arriving. Each now comes in from where it was opened and
// leaves the screen under it alone.
//
// They are built on @starting-style, so the open state is the plain markup: a
// browser without support shows the menu as it is, and nothing is ever left
// invisible waiting for a transition that may not run.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

function rule(selector, from = 0) {
  const start = css.indexOf(`${selector} {`, from);
  expect(start, selector).toBeGreaterThan(-1);
  const open = css.indexOf("{", start);
  return css.slice(open, css.indexOf("}", open));
}

describe("things that open", () => {
  it("drops a context menu in from its trigger", () => {
    expect(rule(".context-menu")).toMatch(/transition:\s*opacity[\s\S]*translate/);
    // Desktop only: on a phone the same element is an action sheet and rises
    // from the thumb (phone.css), so the two entrances must not stack.
    expect(css).toMatch(/@media \(min-width: 761px\) \{\s*\n\s*@starting-style \{\s*\n\s*\.context-menu:not\(\[hidden\]\) \{\s*\n\s*opacity: 0;\s*\n\s*translate: 0 -4px;/);
  });

  it("brings the command sheet down from its field", () => {
    expect(rule(".palette")).toMatch(/transition:\s*opacity/);
    expect(css).toMatch(/@starting-style \{\s*\n\s*\.palette:not\(\[hidden\]\) \{ opacity: 0; \}/);
    expect(rule(".palette-panel")).toMatch(/transition:\s*transform/);
    // It opens where the input is: the top of the sheet, not its centre.
    expect(rule(".palette-panel")).toMatch(/transform-origin:\s*50% 0/);
  });

  it("dims with the dialog instead of behind it", () => {
    expect(rule(".modal-overlay")).toMatch(/transition:\s*opacity/);
    expect(css).toMatch(/@starting-style \{\s*\n\s*\.modal-overlay:not\(\[hidden\]\) \{ opacity: 0; \}/);
    // .modal also appears as ".modal-overlay.auth-overlay .modal": start at the
    // bare rule.
    expect(rule("\n.modal", css.indexOf("/* Modal */"))).toMatch(/transition:\s*transform/);
  });

  it("raises the phone sheet from the edge it lives on", () => {
    expect(rule(".sheet")).toMatch(/transition:\s*transform/);
    expect(css).toMatch(/\.sheet-scrim:not\(\[hidden\]\) \.sheet \{ transform: translateY\(24%\); \}/);
  });

  it("never scales in from nothing", () => {
    // A dialog that grows from scale(0) reads as a pop-up ad; 0.98 is a settle.
    const starts = css.slice(css.indexOf("@starting-style"));
    expect(starts).not.toMatch(/scale\(0\)|scale\(0\.0\d?\)[^)]*\)/);
    expect(starts).toMatch(/scale\(0\.98\)/);
  });

  it("uses no transform on a menu it cannot animate", () => {
    // The menu's own arrival is a small translate, which the reduced-motion
    // block collapses; no menu depends on the transition to be usable.
    expect(rule(".context-menu")).not.toMatch(/display:\s*none/);
  });
});
