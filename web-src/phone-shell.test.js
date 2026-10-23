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

// The title row is the top of the page, not a band: at 56px tall with a 20px
// margin inside a container that also gapped its children by 20px, Library,
// Games, Scout and Teams opened with ~50px of dead ground under the title.
it("the page title row is the action's height and adds no margin of its own", () => {
  const head = rule(".page-head {");
  expect(head).toMatch(/min-height:\s*44px/);
  expect(head).toMatch(/margin:\s*0;/);
  expect(head).not.toMatch(/margin:\s*0 0 var\(--phone-gap\)/);
  // A page that stacks blocks in normal flow still gets one gap from the shell.
  expect(rule(".view > .page-head {")).toMatch(/margin-bottom:\s*var\(--phone-gap\)/);
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

// Every custom property a phone rule reads must be one the app defines. The
// disabled board pill named `--faint`, which exists nowhere: the declaration was
// dropped at computed-value time, so the pill fell back to inherited ink and read
// as a live button (measured at 390: rgb(27,28,30) on rgb(239,239,236)).
it("reads only tokens the app defines, and marks a disabled pill inert", () => {
  const tokens = new Set(
    ["styles.css", "views/settings.css", "views/analyze-chart.css", "views/teams.css", "views/scout.css", "views/replay.css"]
      .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
      .join("\n")
      .match(/--[a-z0-9-]+\s*:/g)
      ?.map((decl) => decl.replace(/\s*:$/, "")) || [],
  );
  // A property a rule sets for its own subtree (a button's own --pill-left) and
  // anything with a fallback is legitimate; a bare read of an unknown token dies.
  const locals = new Set(
    (body.match(/--[a-z0-9-]+\s*:/g) || []).map((decl) => decl.replace(/\s*:$/, "")),
  );
  const reads = [...body.matchAll(/var\((--[a-z0-9-]+)(\s*,)?/g)];
  const undefinedReads = [...new Set(
    reads.filter(([, name, fallback]) => !fallback && !tokens.has(name) && !locals.has(name)).map(([, name]) => name),
  )];
  expect(undefinedReads).toEqual([]);

  const pill = rule(":is(#run-analysis, #build-generate-node):disabled");
  expect(pill).toMatch(/background: var\(--surface-3\)/);
  expect(pill).toMatch(/color: var\(--label\)/);
  expect(pill).not.toMatch(/--faint/);
});
