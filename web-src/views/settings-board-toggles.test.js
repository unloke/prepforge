import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cssSource } from "../test-styles-source.js";
import { renderPrefsToggles } from "../board/ui.js";

// The Board card's switches were a two-column grid: each column's switch sat
// on the right, so the first column's switch landed immediately beside the
// second column's label and the pair a switch belonged to was a guess. One
// toggle per line is the fix; these rules keep a second column from coming back.
const settingsCss = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const phoneCss = cssSource("phone.css");

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

  it("mounts the volume slider in the DOM only when the Board settings card is active", () => {
    expect(html).toContain('<section class="card set" id="set-board" data-area="board" hidden>');
    expect(html).toContain('<section class="card set sw-grid" id="set-appearance" data-area="appearance" hidden>');
    let hidden = true;
    const host = {
      innerHTML: "stale",
      closest: (sel) => (sel === "[hidden]" && hidden ? {} : null),
      querySelectorAll: () => [],
      querySelector: () => null,
    };
    const prevDoc = globalThis.document;
    globalThis.document = { getElementById: (id) => (id === "board-prefs" ? host : null) };
    try {
      renderPrefsToggles();
      expect(host.innerHTML).toBe("");
      hidden = false;
      renderPrefsToggles();
      expect(String(host.innerHTML)).toContain('id="pf-volume"');
      expect(String(host.innerHTML).match(/id="pf-volume"/g)).toHaveLength(1);
    } finally {
      globalThis.document = prevDoc;
    }
  });
});
