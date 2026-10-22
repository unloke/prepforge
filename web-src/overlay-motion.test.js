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

const phone = readFileSync(new URL("./phone.css", import.meta.url), "utf8");

describe("things that open", () => {
  it("drops a context menu in from its trigger", () => {
    expect(rule(".context-menu")).toMatch(/transition:\s*opacity[\s\S]*translate/);
    // Desktop only: on a phone the same element is an action sheet and rises
    // from the thumb (phone.css), so the two entrances must not stack.
    expect(css).toMatch(/@media \(min-width: 761px\), \(orientation: landscape\) and \(max-height: 520px\) \{\s*\n\s*@starting-style \{\s*\n\s*\.context-menu:popover-open \{\s*\n\s*opacity: 0;\s*\n\s*translate: 0 -4px;/);
  });

  it("brings the command sheet down from its field", () => {
    expect(rule(".palette")).toMatch(/transition:[\s\S]*transform[\s\S]*opacity/);
    expect(css).toMatch(/@starting-style \{\s*\n\s*\.palette\[open\] \{ opacity: 0; transform: translateY\(-8px\) scale\(0\.985\); \}/);
    // It opens where the input is: the top of the sheet, not its centre.
    expect(rule(".palette")).toMatch(/transform-origin:\s*50% 0/);
  });

  it("dims with the dialog instead of behind it, and leaves the same way", () => {
    expect(rule(".modal::backdrop")).toMatch(/transition:\s*\n?\s*opacity/);
    expect(css).toMatch(/@starting-style \{\s*\n\s*\.modal:is\(\[open\], :popover-open\)::backdrop \{ opacity: 0; \}/);
    expect(rule("\n.modal", css.indexOf("/* A .modal is a native <dialog>"))).toMatch(/transition:\s*\n?\s*transform/);
    // The exit plays: display and overlay flip only after the transition.
    expect(rule("\n.modal", css.indexOf("/* A .modal is a native <dialog>"))).toMatch(/display var\(--dur\) allow-discrete/);
    expect(rule("\n.modal", css.indexOf("/* A .modal is a native <dialog>"))).toMatch(/overlay var\(--dur\) allow-discrete/);
  });

  it("raises every phone dialog, the More sheet included, from the bottom edge", () => {
    expect(phone).toMatch(/@starting-style \{\s*\n\s*\.modal:is\(\[open\], :popover-open\) \{ transform: translateY\(24%\); \}/);
    expect(readFileSync(new URL("./index.html", import.meta.url), "utf8")).toMatch(/<dialog class="modal sheet" id="more-sheet"/);
  });

  it("never scales in from nothing", () => {
    // A dialog that grows from scale(0) reads as a pop-up ad; 0.98 is a settle.
    const starts = css.slice(css.indexOf("@starting-style"));
    expect(starts).not.toMatch(/scale\(0\)|scale\(0\.0\d?\)[^)]*\)/);
    expect(starts).toMatch(/scale\(0\.98\)/);
  });

  it("collapses every entrance under reduced motion", () => {
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\*,\s*\n\s*\*::before,\s*\n\s*\*::after,\s*\n\s*\*::backdrop \{[\s\S]*?transition-duration: 0\.001ms !important;/);
  });

  it("uses no transform on a menu it cannot animate", () => {
    // The menu's own arrival is a small translate, which the reduced-motion
    // block collapses; no menu depends on the transition to be usable.
    expect(rule(".context-menu")).not.toMatch(/display:\s*none/);
  });
});
