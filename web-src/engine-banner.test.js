import { describe, it, expect } from "vitest";

import {
  engineUnavailableBanner,
  engineBannerHtml,
  ENGINE_BANNER_TITLE,
} from "./engine-banner.js";

describe("engineUnavailableBanner", () => {
  it("hides the banner when the browser engine is available", () => {
    const model = engineUnavailableBanner({ available: true, isolated: true });
    expect(model.visible).toBe(false);
    expect(model.title).toBe("");
    expect(String(engineBannerHtml(model))).toBe("");
  });

  it("shows why + what to do when the page is not cross-origin isolated", () => {
    const model = engineUnavailableBanner({ available: false, isolated: false });
    expect(model.visible).toBe(true);
    expect(model.title).toBe(ENGINE_BANNER_TITLE);
    expect(model.why).toMatch(/cross-origin isolated/i);
    expect(model.why).toMatch(/COOP\/COEP/);
    expect(model.action).toMatch(/Chrome or Edge/);
    expect(model.action).toMatch(/no server fallback/);
    const html = engineBannerHtml(model);
    expect(String(html)).toContain(ENGINE_BANNER_TITLE);
    expect(String(html)).toContain("engine-banner-why");
    expect(String(html)).toContain("engine-banner-action");
  });

  it("keeps the action's whole sentence in its tooltip", () => {
    // Build prints the action on one line and cuts it with an ellipsis, so the
    // tail ("there is no server fallback") is only reachable here.
    const model = engineUnavailableBanner({ available: false, isolated: false });
    const markup = String(engineBannerHtml(model));
    const tag = markup.match(/<p class="engine-banner-action"[^>]*>/)[0];
    expect(tag).toContain(`title="${model.action}"`);
  });

  it("uses a start-failed why when isolated but still unavailable", () => {
    const model = engineUnavailableBanner({ available: false, isolated: true });
    expect(model.visible).toBe(true);
    expect(model.why).toMatch(/could not start/i);
    expect(model.action).toMatch(/Reload/);
  });

  it("passes through an explicit provider reason", () => {
    const model = engineUnavailableBanner({
      available: false,
      isolated: false,
      reason: "wasm blocked by CSP",
    });
    expect(model.why).toBe("wasm blocked by CSP");
  });

  it("escapes provider text when rendering without an injected escaper", () => {
    const reason = '<img src=x onerror="alert(1)">';
    const markup = engineBannerHtml(engineUnavailableBanner({ available: false, reason }));
    expect(String(markup)).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(String(markup)).not.toContain(reason);
  });
});
