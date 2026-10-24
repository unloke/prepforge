// Build with nothing open: the three ways in must all read as buttons. Browse…
// was `.btn.ghost` — the app's quiet text action, transparent with no edge —
// so beside a filled New repertoire and an outlined Import PGN it read
// disabled. And the head's ⋯ was a bare <button> with no `.btn` class, so it
// painted with the UA's 2px outset border: the only boxed icon in the app.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

it("every control in the empty card carries the button system's surface", () => {
  const card = html.slice(html.indexOf('id="build-empty"'), html.indexOf('id="build-branchbar"'));
  const buttons = [...card.matchAll(/<button class="([^"]*)"[^>]*>([^<]*)</g)];
  expect(buttons.map(([, , label]) => label)).toEqual(["New repertoire", "Import PGN", "Browse…"]);
  for (const [, cls, label] of buttons) {
    expect(cls.split(" "), `${label} is a plain .btn`).toContain("btn");
    expect(cls, `${label} must not be the quiet text variant`).not.toMatch(/\bghost\b/);
  }
  // One primary: the one that makes a new repertoire.
  expect(buttons.filter(([, cls]) => /\bprimary\b/.test(cls))).toHaveLength(1);
});

it("the head's ⋯ is the app's shared icon button, not a bare button", () => {
  const tag = /<button class="([^"]*)" id="build-menu"[^>]*>/.exec(html);
  expect(tag, "the Build ⋯ button").not.toBeNull();
  const cls = tag[1].split(" ");
  expect(cls).toContain("btn");
  expect(cls).toContain("icon");
  expect(tag[0]).toMatch(/aria-label="More actions"/);
});

it("the board bar adds no second caption to the empty screen", () => {
  // The head says "No repertoire open" and the panel says "Start a repertoire";
  // a third "No repertoire" under the board said nothing new.
  const label = /<span class="board-label" id="build-board-label">([^<]*)<\/span>/.exec(html);
  expect(label, "the Build board label").not.toBeNull();
  expect(label[1]).toBe("");
});
