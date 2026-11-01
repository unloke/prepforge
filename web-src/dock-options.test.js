import { afterEach, describe, expect, it, vi } from "vitest";
import { dockOptionsLabel, toggleDockOptions } from "./dock-options.js";

const popover = vi.hoisted(() => ({ onClose: null }));
vi.mock("./core/dialog.js", () => ({ openPopover: (el, { onClose }) => { popover.onClose = onClose; } }));

describe("dockOptionsLabel", () => {
  it("names the Explorer's database", () => {
    expect(dockOptionsLabel({ tab: "explorer", db: "masters" })).toBe("Masters");
    expect(dockOptionsLabel({ tab: "explorer", db: "lichess" })).toBe("Players");
  });
  it("names Coverage's scope and horizon", () => {
    expect(dockOptionsLabel({ tab: "coverage", scope: "repertoire", horizon: "8 moves" })).toBe("Mainline · 8 moves");
    expect(dockOptionsLabel({ tab: "coverage", scope: "branch", horizon: "2 moves" })).toBe("Branch · 2 moves");
    expect(dockOptionsLabel({ tab: "coverage", scope: "branch", horizon: "" })).toBe("Branch");
  });
});

describe("toggleDockOptions", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A window that starts at desktop size and can cross the phone breakpoint.
  function stage() {
    const listeners = new Set();
    const media = {
      matches: false,
      addEventListener: (type, fn) => listeners.add(fn),
      removeEventListener: (type, fn) => listeners.delete(fn),
    };
    const win = { innerWidth: 1440, innerHeight: 900, matchMedia: () => media };
    const tools = { style: {}, offsetWidth: 300, offsetHeight: 200, matches: () => false, querySelector: () => null };
    const button = { getBoundingClientRect: () => ({ left: 1068, bottom: 100 }) };
    vi.stubGlobal("window", win);
    vi.stubGlobal("document", { getElementById: (id) => ({ "build-dock-tools": tools, "build-dock-opts": button })[id] });
    const resize = (phone, width) => {
      media.matches = phone;
      win.innerWidth = width;
      for (const fn of [...listeners]) fn({ matches: phone });
    };
    return { tools, listeners, resize };
  }

  it("drops the desktop coordinates when an open panel crosses into the phone layout", () => {
    const { tools, resize } = stage();
    toggleDockOptions();
    expect(tools.style).toEqual({ left: "1068px", top: "104px" });
    resize(true, 390);
    expect(tools.style).toEqual({ left: "", top: "" });
    resize(false, 1180);
    expect(tools.style).toEqual({ left: "872px", top: "104px" });
  });

  it("stops following the breakpoint once closed", () => {
    const { listeners } = stage();
    toggleDockOptions();
    expect(listeners.size).toBe(1);
    popover.onClose();
    expect(listeners.size).toBe(0);
  });
});
