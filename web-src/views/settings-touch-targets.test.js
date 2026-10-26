import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// Settings is a thumb target on a phone: switches were 38x26 and the info
// buttons 24x24, both under the 40px target. The phone sheets (settings.css +
// phone.css) set the sizes; these rules keep a later edit from shrinking them.
const settingsCss = readFileSync(new URL("./settings.css", import.meta.url), "utf8");
const phoneCss = readFileSync(new URL("../phone.css", import.meta.url), "utf8");
const sharedCss = readFileSync(new URL("../styles.css", import.meta.url), "utf8");

function ruleBody(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at));
}

function phoneRule(css, selector) {
  const phone = css.slice(css.indexOf("@media (max-width: 760px)"));
  return ruleBody(phone, selector);
}

describe("Settings phone touch targets", () => {
  it("keeps the shared switch track and lets the shared tap area reach 44px", () => {
    // The switch is drawn 34x20 everywhere; one shared ::after gives it a thumb
    // target, so Settings no longer redraws the track on a phone.
    expect(ruleBody(sharedCss, ".pf-switch")).toMatch(/height:\s*var\(--switch-h\)/);
    const hit = ruleBody(sharedCss, ".pf-switch::after");
    const inset = Number(/inset:\s*-(\d+)px/.exec(hit)?.[1]);
    expect(Number(/--switch-h:\s*(\d+)px/.exec(sharedCss)?.[1]) + 2 * inset).toBeGreaterThanOrEqual(44);
    expect(settingsCss).not.toMatch(/\.set \.pf-switch::after/);
  });

  it("gives the info buttons a 44px box", () => {
    const body = phoneRule(settingsCss, ".set .pf-info");
    expect(body).toMatch(/min-width:\s*44px/);
    expect(body).toMatch(/min-height:\s*44px/);
  });

  it("keeps row buttons and segmented choices at 44px on a phone", () => {
    // They come from the shared phone rule now; Settings sets only padding.
    expect(phoneCss).toMatch(/\.btn,\n  \.btn\.sm,\n  \.seg-btn,\n  \.sum-chip,[\s\S]*?\{ min-height: 44px; height: 44px; \}/);
    const row = phoneCss.match(/#view-settings \.set :is\(\.btn, \.btn\.sm\) \{[^}]*\}/)[0];
    expect(row).not.toMatch(/height:/);
  });

  it("leaves the desktop switch dense", () => {
    expect(ruleBody(sharedCss, ".pf-switch")).toMatch(/height:\s*var\(--switch-h\)/);
    expect(sharedCss).toMatch(/--switch-h:\s*20px/);
  });
});

describe("Settings phone switch knob", () => {
  it("keeps one switch: the shared track draws it, with no phone redraw", () => {
    // A view-drawn ::after track covered the knob and every phone switch read
    // as a bare pill; the shared rule is the only track now.
    expect(settingsCss).not.toMatch(/\.set \.pf-switch \{/);
    expect(ruleBody(sharedCss, ".pf-switch")).toMatch(/background:\s*var\(--panel-soft\)/);
  });
});
