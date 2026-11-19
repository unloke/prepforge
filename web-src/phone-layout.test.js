import { describe, expect, it } from "vitest";
import { PHONE_QUERY, closeSheetOffPhone, trackVisualViewport } from "./phone-layout.js";

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

function viewportWindow() {
  const viewport = new EventTarget();
  Object.assign(viewport, { height: 664, offsetTop: 0, scale: 1 });
  const win = new EventTarget();
  const frames = new Map();
  let id = 0;
  Object.assign(win, {
    visualViewport: viewport,
    innerHeight: 664,
    requestAnimationFrame: (fn) => { frames.set(++id, fn); return id; },
    cancelAnimationFrame: (key) => frames.delete(key),
  });
  const values = new Map();
  const root = { style: {
    setProperty: (key, value) => values.set(key, value),
    removeProperty: (key) => values.delete(key),
  } };
  return { win, viewport, root, values, frames, flush: () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((fn) => fn());
  } };
}

describe("trackVisualViewport", () => {
  it("fits browser chrome on entry and follows its expanding viewport", () => {
    const { win, viewport, root, values, flush } = viewportWindow();
    trackVisualViewport(win, root);
    expect(values.get("--viewport-height")).toBe("664px");
    viewport.height = win.innerHeight = 844;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(values.get("--viewport-height")).toBe("844px");
    expect(values.get("--viewport-bottom")).toBe("0px");
  });

  it("keeps sheets above the keyboard when it pans the visual viewport", () => {
    const { win, viewport, root, values, frames, flush } = viewportWindow();
    trackVisualViewport(win, root);
    viewport.height = 360;
    viewport.offsetTop = 40;
    viewport.dispatchEvent(new Event("resize"));
    viewport.dispatchEvent(new Event("scroll"));
    win.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(1);
    flush();
    expect(Object.fromEntries(values)).toEqual({
      "--viewport-height": "360px", "--viewport-top": "40px", "--viewport-bottom": "264px",
    });
  });

  it("does not reflow the app while pinch zooming", () => {
    const { win, viewport, root, values, flush } = viewportWindow();
    trackVisualViewport(win, root);
    viewport.scale = 2;
    viewport.height = 332;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(values.get("--viewport-height")).toBe("664px");
    viewport.scale = 1;
    viewport.height = 600;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(values.get("--viewport-height")).toBe("600px");
  });

  it("rounds geometry, ignores zero-sized viewports, and clamps overscroll", () => {
    const { win, viewport, root, values, flush } = viewportWindow();
    viewport.height = 664.4;
    trackVisualViewport(win, root);
    expect(values.get("--viewport-bottom")).toBe("0px");
    viewport.height = 0;
    viewport.dispatchEvent(new Event("resize"));
    flush();
    expect(values.get("--viewport-height")).toBe("664px");
  });

  it("cancels queued updates and removes listeners on teardown", () => {
    const { win, viewport, root, values, frames } = viewportWindow();
    const stop = trackVisualViewport(win, root);
    viewport.dispatchEvent(new Event("resize"));
    stop();
    expect(frames.size).toBe(0);
    expect(values.size).toBe(0);
    viewport.dispatchEvent(new Event("scroll"));
    win.dispatchEvent(new Event("resize"));
    expect(frames.size).toBe(0);
  });

  it("leaves dynamic viewport CSS in charge when the API is unavailable", () => {
    expect(() => trackVisualViewport({}, {}).call()).not.toThrow();
  });
});
