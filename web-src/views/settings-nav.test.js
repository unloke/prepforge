import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createSettingsView } from "./settings.js";

// Settings' section strip is the page's only navigation, so it has to answer
// two questions without being hunted for: where the sections are, and which
// one is open. markActiveSection is the one place that paints both the strip
// and the heading, so these tests pin every fact it must keep in agreement.

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const css = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
const phoneCss = readFileSync(new URL("../phone.css", import.meta.url), "utf8");
const sharedCss = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

const SECTIONS = [
  ["#set-account", "Account"],
  ["#set-appearance", "Appearance"],
  ["#set-engine", "Engine"],
  ["#set-maia", "Maia3"],
  ["#set-strength", "Playing strength"],
  ["#set-board", "Board"],
];

function fakeNav() {
  const here = { textContent: "" };
  const links = SECTIONS.map(([href, label], index) => {
    const attrs = {};
    const classes = new Set();
    return {
      label,
      textContent: label,
      offsetLeft: index * 80,
      offsetWidth: 80,
      addEventListener: () => {},
      getAttribute: (name) => (name === "href" ? href : attrs[name] ?? null),
      setAttribute: (name, value) => { attrs[name] = String(value); },
      removeAttribute: (name) => { delete attrs[name]; },
      classList: {
        toggle: (name, on) => { if (on) classes.add(name); else classes.delete(name); },
        contains: (name) => classes.has(name),
      },
      attrs,
    };
  });
    const nav = {
      scrollWidth: 480,
      clientWidth: 320,
      scrollLeft: 0,
      dataset: {},
      querySelector: (sel) => (sel === ".settings-nav-link.is-active" ? links.find((l) => l.classList.contains("is-active")) ?? null : null),
      querySelectorAll: (sel) => (sel === ".settings-nav-link" ? links : []),
    };
  return { nav, links, here };
}

function setup() {
  const { nav, links, here } = fakeNav();
  globalThis.document = {
    getElementById: (id) => (id === "settings-current" ? here : null),
    querySelector: (sel) => (sel === ".settings-nav" ? nav : null),
    querySelectorAll: (sel) => (sel === ".settings-nav .settings-nav-link" ? links : []),
    addEventListener: vi.fn(),
  };
  const view = createSettingsView({
    appState: {},
    setStatus: vi.fn(),
    saveSettings: vi.fn(),
    loadSettings: vi.fn(),
    pref: () => false,
    setPref: vi.fn(),
    effectiveMaiaRating: () => 1500,
    getSharedMaia3Provider: () => null,
    disposeSharedMaia3Provider: vi.fn(),
    showConfirmModal: vi.fn(),
    startFen: "startpos",
    api: async () => ({}),
    postJson: async () => ({}),
  });
  return { view, links, here, nav };
}

afterEach(() => {
  delete globalThis.document;
});

describe("Settings section navigation", () => {
  it("marks exactly one section active and names it in the heading", () => {
    const { view, links, here } = setup();
    view.markActiveSection("set-strength");
    const active = links.filter((link) => link.classList.contains("is-active"));
    expect(active).toHaveLength(1);
    expect(active[0].label).toBe("Playing strength");
    expect(here.textContent).toBe("Playing strength");
  });

  it("gives the open link aria-current and takes it off the others", () => {
    const { view, links } = setup();
    view.markActiveSection("set-engine");
    for (const link of links) {
      if (link.label === "Engine") expect(link.attrs["aria-current"]).toBe("true");
      else expect(link.attrs["aria-current"]).toBeUndefined();
    }
  });

  it("re-marks on every section, never leaving two lit", () => {
    const { view, links, here } = setup();
    for (const [href, label] of SECTIONS) {
      view.markActiveSection(href.slice(1));
      expect(links.filter((link) => link.classList.contains("is-active"))).toHaveLength(1);
      expect(here.textContent).toBe(label);
    }
  });

  it("scrolls an off-screen active chip into the strip on a phone", () => {
    const { view, nav } = setup();
    view.markActiveSection("set-board");
    expect(nav.scrollLeft).toBeGreaterThan(0);
  });

  it("keeps every section reachable from the strip and the heading in the page", () => {
    const view = html.slice(html.indexOf('id="view-settings"'), html.indexOf("</main>"));
    for (const [href, label] of SECTIONS) {
      expect(view).toContain(`href="${href}"`);
      expect(view).toContain(`id="${href.slice(1)}"`);
      expect(view).toContain(`>${label}</a>`);
    }
    expect(view).toContain('data-testid="settings-current"');
  });

  it("keeps the strip on a phone instead of hiding it", () => {
    const phone = phoneCss.slice(phoneCss.indexOf("@media (max-width: 760px)"));
    expect(phone).not.toMatch(/#view-settings \.settings-nav \{ display: none; \}/);
    expect(phone).toMatch(/#view-settings \.settings-nav \{[\s\S]*?position: sticky;/);
    expect(phone).toMatch(/#view-settings \.settings-nav-link \{[\s\S]*?min-height: 44px;/);
  });

  it("puts the strip on a surface of its own and holds it while cards scroll", () => {
    expect(sharedCss).toMatch(/\.settings-nav \{[\s\S]*?position: sticky;[\s\S]*?background: var\(--panel\);/);
    // The open section is the page's strongest mark: a filled ink plate.
    expect(css).toMatch(/\.settings-nav-link\.is-active \{[\s\S]*?background: var\(--text\);[\s\S]*?color: var\(--panel\);/);
  });

  it("lands a jumped-to card below the sticky strip", () => {
    expect(css).toMatch(/\.settings-content > \.set \{ scroll-margin-top: 64px; \}/);
    expect(phoneCss).toMatch(/#view-settings \.settings-content > \.set \{ scroll-margin-top: 112px; \}/);
  });

  it("leaves the click's marker alone when every card fits on screen", async () => {
    // At 1440x900 the six cards fit with no room to scroll: the spy has no
    // section "in front of you", so a click's marker must not be overwritten
    // on the scroll event that a smooth-scroll still fires.
    const { view, links } = setup();
    globalThis.window = { innerHeight: 900, scrollY: 0 };
    globalThis.document.documentElement = { scrollHeight: 900 };
    const listeners = [];
    globalThis.document.addEventListener = (name, fn) => { if (name === "scroll") listeners.push(fn); };
    globalThis.requestAnimationFrame = (fn) => fn();
    const cards = SECTIONS.map(([href]) => ({
      id: href.slice(1),
      getBoundingClientRect: () => ({ top: 100, bottom: 200 }),
    }));
    globalThis.document.querySelectorAll = (sel) =>
      sel === "#view-settings .card[id]" ? cards : (sel === ".settings-nav .settings-nav-link" ? links : []);
    view.bindSectionNav();
    view.markActiveSection("set-board");
    listeners.forEach((fn) => fn());
    expect(links.find((link) => link.classList.contains("is-active")).label).toBe("Board");
    delete globalThis.window;
    delete globalThis.requestAnimationFrame;
  });
});
