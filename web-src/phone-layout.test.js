import { describe, expect, it } from "vitest";
import { PHONE_QUERY, closeSheetOffPhone } from "./phone-layout.js";

function fakeMatchMedia() {
  const listeners = [];
  return {
    asked: null,
    listenerCount: () => listeners.length,
    matchMedia(query) {
      this.asked = query;
      return {
        matches: true,
        addEventListener: (type, fn) => { if (type === "change") listeners.push(fn); },
        removeEventListener: (type, fn) => {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      };
    },
    change(matches) { for (const fn of [...listeners]) fn({ matches }); },
  };
}

describe("closeSheetOffPhone", () => {
  it("closes the sheet when the window widens past the phone breakpoint", () => {
    const win = fakeMatchMedia();
    let closed = 0;
    closeSheetOffPhone(() => { closed += 1; }, (q) => win.matchMedia(q));
    expect(win.asked).toBe(PHONE_QUERY);
    win.change(false);
    expect(closed).toBe(1);
  });

  it("keeps an open sheet on the phone and unbinds on teardown", () => {
    const win = fakeMatchMedia();
    let closed = 0;
    const unbind = closeSheetOffPhone(() => { closed += 1; }, (q) => win.matchMedia(q));
    win.change(true);
    expect(closed).toBe(0);
    unbind();
    win.change(false);
    expect(closed).toBe(0);
  });

  it("survives a window without matchMedia", () => {
    expect(() => closeSheetOffPhone(() => {}, undefined)).not.toThrow();
  });
});
