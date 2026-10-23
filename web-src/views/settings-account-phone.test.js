import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The identity block on a phone: the avatar sits at the card's edge and the
// name, email and badges start 60px in (48px avatar + the block's 12px gap).
// Sign out used to sit 52px in, 8px short of that edge, under the badges: it
// read as a stray button. It takes its own line on the name's edge instead.
const phoneCss = readFileSync(new URL("../phone.css", import.meta.url), "utf8");
const phone = phoneCss.slice(phoneCss.indexOf("@media (max-width: 760px)"));

function rule(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at));
}

describe("Settings phone identity block", () => {
  it("puts Sign out on the name's edge, on its own line", () => {
    expect(rule(phone, "#view-settings .acct-id")).toMatch(/flex-wrap:\s*wrap/);
    expect(rule(phone, "#view-settings .acct-signout")).toMatch(/margin:\s*2px 0 0 60px/);
  });

  it("keeps the text block beside the avatar", () => {
    expect(rule(phone, "#view-settings .acct-id-text")).toMatch(/flex:\s*1 1 calc\(100% - 60px\)/);
  });
});
