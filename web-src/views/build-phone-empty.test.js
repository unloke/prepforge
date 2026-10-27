// The phone Build screen with nothing open is its empty card under the board.
// Round 5: the board keeps the full width on every board screen (it never
// shrinks to make room), and the region under it scrolls: when a phone leaves
// it less than 140px the study itself scrolls, so the empty card's second
// action row (Import PGN, Browse) is reached by scrolling, never cut off by the
// thumb bar.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const phone = readFileSync(new URL("../phone.css", import.meta.url), "utf8");
const body = phone.slice(phone.lastIndexOf("@media (max-width: 760px)"));

it("keeps the board full width and lets the region under it scroll", () => {
  expect(body).toMatch(/\.study \.board-stack \{ width: 100vw; \}/);
  expect(body).not.toMatch(/--phone-reserve/);
  // It scrolls down only: sideways it would carry the 100vw board off the edge.
  expect(body).toMatch(/:is\(#view-analyze, #view-build, #view-train\) \.study \{ overflow-x: hidden; overflow-y: auto;/);
  expect(body).toMatch(/#build-sidebar > \.panel-body[^{]*\{ flex: 1 0 140px;/);
  // The thumb bar stays on screen while the study scrolls.
  expect(body).toMatch(/\.study \.board-bar \{ position: sticky; bottom: 0;/);
});

it("does not spend the room on the card's copy", () => {
  // The empty card keeps its sentence: a shorter message is not the fix.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const card = html.slice(html.indexOf('id="build-empty"'), html.indexOf('id="build-branchbar"'));
  expect(card).toContain("Start a repertoire");
  expect(card).toContain("Open one from the Library, or play a move.");
  expect(card).toContain("New repertoire");
  expect(card).toContain("Import PGN");
  expect(card).toContain("Browse…");
});
