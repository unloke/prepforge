// The phone shell: the title row and the bottom bar. The title was set at the
// desktop settings size (32/800) on every phone page, where it out-shouted the
// content it named, and the bottom bar carried a floating shadow and painted
// the open destination in ink-blue — the one accent belongs to the screen's
// action, not to the chrome.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const phone = readFileSync(new URL("./phone.css", import.meta.url), "utf8");
const body = phone.slice(phone.lastIndexOf("@media (max-width: 760px)"));

function rule(selector) {
  const start = body.indexOf(`\n  ${selector}`);
  expect(start, selector).toBeGreaterThan(-1);
  const open = body.indexOf("{", start);
  return body.slice(open, body.indexOf("}", open));
}

it("sets the phone page title at the app-title size, not a display size", () => {
  const title = rule(".page-head h1");
  expect(title).toMatch(/font-size:\s*22px/);
  expect(title).toMatch(/font-weight:\s*650/);
});

it("keeps the page header's action a thumb target in ink", () => {
  const button = rule(".page-head-btn {");
  expect(button).toMatch(/width:\s*44px/);
  expect(button).toMatch(/height:\s*44px/);
  expect(button).toMatch(/color:\s*var\(--text\)/);
});

it("draws the bottom bar as chrome: a tone step, no shadow, ink selection", () => {
  const bar = rule(".tabbar {");
  expect(bar).toMatch(/border-top:\s*1px solid var\(--line\)/);
  expect(bar).toMatch(/box-shadow:\s*none/);
  const item = rule(".tabbar .tabbar-item.is-active");
  expect(item).toMatch(/color:\s*var\(--text\)/);
  expect(item).not.toMatch(/--accent/);
});

it("keeps every bottom bar destination at a 44px hit height", () => {
  const item = rule(".tabbar .tabbar-item {");
  expect(item).toMatch(/height:\s*56px/);
});
