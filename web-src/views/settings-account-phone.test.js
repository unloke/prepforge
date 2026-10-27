import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The identity block on a phone heads a grouped list: avatar and name on one
// row, then Password and the plan as rows, and Sign out closes the list as a
// row of its own. Hung under the email it read as a stray, orphaned button.
const phoneCss = readFileSync(new URL("../phone.css", import.meta.url), "utf8");
const phone = phoneCss.slice(phoneCss.indexOf("@media (max-width: 760px)"));

function rule(css, selector) {
  const at = css.indexOf(selector + " {");
  if (at < 0) return "";
  return css.slice(at, css.indexOf("}", at));
}

describe("Settings phone identity block", () => {
  it("closes the list with Sign out as its own full-width row", () => {
    expect(rule(phone, "#view-settings .acct-id")).toMatch(/display:\s*contents/);
    const signout = rule(phone, "#view-settings .set .btn.acct-signout");
    expect(signout).toMatch(/grid-column:\s*1 \/ -1/);
    expect(signout).toMatch(/order:\s*9/);
  });

  it("keeps the text block beside the avatar", () => {
    expect(rule(phone, "#view-settings #settings-account-body")).toMatch(/grid-template-columns:\s*48px minmax\(0, 1fr\)/);
  });
});
