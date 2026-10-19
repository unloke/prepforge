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
  it("grows the switch hit box to 40px and keeps the track 18px", () => {
    expect(phoneRule(settingsCss, ".set .pf-switch")).toMatch(/height:\s*40px/);
    expect(ruleBody(settingsCss, ".set .pf-switch::after")).toMatch(/inset:\s*9px 0/);
  });

  it("gives the info buttons a 40px box", () => {
    const body = phoneRule(settingsCss, ".set .pf-info");
    expect(body).toMatch(/min-width:\s*40px/);
    expect(body).toMatch(/min-height:\s*40px/);
  });

  it("keeps row buttons and segmented choices at 40px on a phone", () => {
    const buttons = phoneRule(phoneCss, "#view-settings .set :is(.btn, .btn.sm):not(.primary)");
    expect(buttons).toMatch(/min-height: 40px/);
    expect(buttons).toMatch(/height: 40px/);
    const seg = phoneRule(phoneCss, "#view-settings .set .seg-btn");
    expect(seg).toMatch(/min-height: 40px/);
    expect(seg).toMatch(/height: 40px/);
  });

  it("leaves the desktop switch dense", () => {
    expect(ruleBody(sharedCss, ".pf-switch")).toMatch(/height:\s*22px/);
  });
});
