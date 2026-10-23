import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createSettingsRouter } from "./settings-router.js";

// Each Settings area is one view: the nav link and the hash name the same area,
// and a click or a back/forward shows only that area's cards. The title stays
// "Settings".

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

function link(area, label) {
  const classes = new Set();
  const attrs = { href: `#/settings/${area}`, "data-area": area };
  return {
    label,
    dataset: { area },
    textContent: label,
    getAttribute: (name) => attrs[name] ?? null,
    setAttribute: (name, value) => { attrs[name] = String(value); },
    removeAttribute: (name) => { delete attrs[name]; },
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
  };
}

function setup(hash = "") {
  const links = [link("account", "Account"), link("appearance", "Appearance"), link("board", "Board"), link("engine", "Engine")];
  const handlers = {};
  const nav = {
    querySelectorAll: () => links,
    addEventListener: (type, fn) => { handlers[type] = fn; },
  };
  const shown = [];
  globalThis.location = { hash };
  globalThis.history = { pushState: vi.fn((_, __, url) => { globalThis.location.hash = url; }) };
  const router = createSettingsRouter({ showArea: (area) => shown.push(area), navEl: nav });
  return { links, handlers, shown, router };
}

describe("Settings area router", () => {
  it("opens the area named by the hash, and the last area without one", () => {
    const a = setup("#/settings/engine");
    a.router.open();
    expect(a.shown).toEqual(["engine"]);
    expect(a.links.find((l) => l.label === "Engine").classList.contains("is-active")).toBe(true);

    const b = setup("#/settings");
    b.router.open();
    expect(b.shown).toEqual(["account"]);
    b.router.hashChanged();
    expect(b.shown).toEqual(["account"]);
  });

  it("a click on a link shows its area and writes the hash", () => {
    const { links, handlers, shown, router } = setup("");
    router.open();
    const preventDefault = vi.fn();
    handlers.click({ preventDefault, target: { closest: () => links[2] } });
    expect(preventDefault).toHaveBeenCalled();
    expect(globalThis.history.pushState).toHaveBeenCalledWith(null, "", "#/settings/board");
    expect(shown.at(-1)).toBe("board");
    expect(links.filter((l) => l.classList.contains("is-active")).map((l) => l.label)).toEqual(["Board"]);
    expect(links[2].getAttribute("aria-current")).toBe("true");
    expect(links[0].getAttribute("aria-current")).toBe(null);
  });

  it("back and forward show the area in the hash", () => {
    const { handlers, shown, router } = setup("");
    router.open();
    globalThis.location.hash = "#/settings/appearance";
    router.hashChanged();
    expect(shown.at(-1)).toBe("appearance");
  });

  it("the markup has one link and one card per area, and a fixed Settings title", () => {
    const view = html.slice(html.indexOf('id="view-settings"'), html.indexOf("</main>"));
    for (const area of ["account", "appearance", "board", "engine"]) {
      expect(view).toContain(`href="#/settings/${area}" data-area="${area}"`);
    }
    expect(view.match(/class="settings-nav-link/g)).toHaveLength(4);
    expect(view.match(/<h1 /g)).toHaveLength(1);
    expect(view).toContain(">Settings</h1>");
    expect(view).not.toContain('id="settings-here"');
    for (const card of ["set-account", "set-appearance", "set-board", "set-engine", "set-maia", "set-strength"]) {
      expect(view).toMatch(new RegExp(`id="${card}" data-area="[a-z]+"`));
    }
    expect(view.match(/id="piece-style-picker"/g)).toHaveLength(1);
  });
});
