// Round 5 phone board contract, shared by the board-screen smokes.
//
// The user rejected rounds 2-4 because the board changed size from tab to tab
// and every control was drawn 44px+. Round 5 (BRIEF_UX_OCT26_R5.md) measured
// Lichess at 390px and fixed the phone design to:
//   - one board, the full viewport width, square, edge to edge, in every
//     board screen and every tab/state of it (it never shrinks for a pane);
//   - no peek sheet / drag-to-resize handle on a board screen;
//   - a 48px thumb bar;
//   - tabs drawn 36px, each with a 44px tap target round it.
// checkPhoneBoard returns a list of failures (empty = holds) so each smoke
// reports them through its own check().
import { hitAreaSource } from "./hit-area.mjs";

export async function checkPhoneBoard(page, { view, board, tabs = null, label = "" }) {
  const got = await page.evaluate(({ view, board, tabs, src }) => {
    const hitArea = eval(src);
    const root = document.getElementById(view);
    const b = document.getElementById(board)?.getBoundingClientRect();
    const bar = root?.querySelector(".board-bar")?.getBoundingClientRect();
    const peek = [...document.querySelectorAll(`#${view} [data-peek], #${view} .peek-grab, #${view} .sheet-grab, #${view} [data-drag-resize]`)]
      .filter((el) => el.getBoundingClientRect().height > 0).map((el) => el.className || el.tagName);
    const tabRows = tabs
      ? [...document.querySelectorAll(tabs)].filter((el) => el.getBoundingClientRect().height > 0).map((el) => {
        const r = el.getBoundingClientRect();
        const hit = hitArea(el);
        return { id: el.id || el.textContent.trim().slice(0, 12), h: Math.round(r.height), hit: hit.h };
      })
      : [];
    return {
      vw: document.documentElement.clientWidth,
      board: b ? { left: Math.round(b.left), width: Math.round(b.width), height: Math.round(b.height) } : null,
      bar: bar && bar.height ? Math.round(bar.height) : null,
      peek,
      tabRows,
    };
  }, { view, board, tabs, src: hitAreaSource });
  const fails = [];
  const at = label ? `${label}: ` : "";
  if (!got.board) fails.push(`${at}#${board} is not on screen`);
  else {
    if (Math.abs(got.board.width - got.vw) > 1 || got.board.left !== 0) fails.push(`${at}the board must run edge to edge at ${got.vw}px, got ${JSON.stringify(got.board)}`);
    if (Math.abs(got.board.width - got.board.height) > 1) fails.push(`${at}the board must be square, got ${JSON.stringify(got.board)}`);
  }
  if (got.bar !== null && got.bar !== 48) fails.push(`${at}the thumb bar is 48px, got ${got.bar}`);
  if (got.peek.length) fails.push(`${at}no peek sheet or drag handle on a board screen, got ${got.peek.join(", ")}`);
  for (const t of got.tabRows) {
    if (t.h > 37 || t.hit < 44) fails.push(`${at}tab "${t.id}" is drawn 36px with a 44px target, got drawn ${t.h} / target ${t.hit}`);
  }
  return { fails, got };
}
