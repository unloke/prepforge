// The phone Build screen with nothing open is its empty card, and that card has
// to fit the room the board leaves it: at 390x660 the reserve was 244px, which
// left the panel body 156px for a card that needs 196px (170 of content, the
// body's 10+16px padding and its 10px gap), so the second action row — Import
// PGN and Browse — was cut off by the thumb bar (measured: card bottom 628 under
// a bar whose top is 604).
//
// The fix is the size of the room, not the card's words: the reserve is the
// smallest that fits the card whole at 390x660, 430x740 and 390x844.
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";

const phone = readFileSync(new URL("../phone.css", import.meta.url), "utf8");
const body = phone.slice(phone.lastIndexOf("@media (max-width: 760px)"));

it("leaves the empty card's room for the whole card on the shortest phone", () => {
  const reserve = body.match(/#view-build \{ --phone-reserve: ([^;]+); \}/);
  expect(reserve, "the Repertoire reserve").not.toBeNull();
  const px = Number((reserve[1].match(/max\((\d+)px/) || [])[1]);
  expect(Number.isFinite(px), `a px reserve in "${reserve[1]}"`).toBe(true);
  // The card is 170px and the panel body adds 10px of top and 16px of bottom
  // padding, so the body needs 196px (measured: the card's scrollHeight was 170
  // and the body's 196, at every viewport). At 390x660 the layout is: 108px
  // (safe area + header) | board | panel body | 56px bar, the board being
  // min(390, 660 - 56 - reserve) with the reserve max(px, 40dvh) = 304 at that
  // height.
  const card = 170 + 10 + 16;
  const effective = Math.max(px, 0.4 * 660);
  const board = Math.min(390, 660 - 56 - effective);
  const panel = 660 - 108 - board - 56;
  expect(panel, `a ${px}px reserve at 390x660`).toBeGreaterThanOrEqual(card);
  // …and not so large that the board becomes a thumbnail: 300px of width is the
  // floor it keeps on that same phone.
  expect(board).toBeGreaterThanOrEqual(300);
});

it("does not spend the reserve on the card's copy", () => {
  // The empty card keeps its sentence: a shorter message is not the fix.
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const card = html.slice(html.indexOf('id="build-empty"'), html.indexOf('id="build-tree-meta"'));
  expect(card).toContain("Start a repertoire");
  expect(card).toContain("Open one from the Library, or play a move.");
  expect(card).toContain("New repertoire");
  expect(card).toContain("Import PGN");
  expect(card).toContain("Browse…");
});
