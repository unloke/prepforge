import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The Board card's switches were a two-column grid: each column's switch sat
// on the right, so the first column's switch landed immediately beside the
// second column's label and the pair a switch belonged to was a guess. One
// toggle per line is the fix; these rules keep a second column from coming back.
const settingsCss = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
const phoneCss = readFileSync(new URL("../phone.css", import.meta.url), "utf8");

function body(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at));
}

describe("Settings → Board toggle rows", () => {
  it("lists the toggles in one column", () => {
    const grid = body(settingsCss, ".sw-grid");
    expect(grid).toMatch(/display:\s*grid/);
    expect(grid).not.toMatch(/grid-template-columns/);
    // A phone keeps the same single list; a second column was removed from the
    // phone sheet too, so nothing can re-split the rows there.
    expect(phoneCss).not.toMatch(/#view-settings \.sw-grid \{[^}]*grid-template-columns/);
  });

  it("keeps each switch on its label's line, a little denser than a control row", () => {
    expect(body(settingsCss, ".sw-grid .pf-row")).toMatch(/padding:\s*4px 0/);
  });
});
