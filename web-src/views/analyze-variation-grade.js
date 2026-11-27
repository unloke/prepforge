import { html } from "../html.js";
import { classBadgeSymbol, classGroup } from "../move-grades.js";
import { nodeGrade } from "../analyze-tried-grade.js";
import { reportGradeLabel } from "./analyze-report.js";

// One effective grade read for mainline moves and variations alike: saved grade
// first, live tried grade second. The sheet only shows the glyph outside the
// ordinary good group; head and board badges still carry that quieter ✓.
export function moveDecoration(node) {
  const grade = nodeGrade(node);
  const glyph = classGroup(grade) === "good" ? "" : classBadgeSymbol(grade);
  const label = [node.isVariation ? "variation" : "", reportGradeLabel(grade)].filter(Boolean).join(", ");
  return {
    classes: [
      node.isVariation ? "is-variation" : "",
      grade ? `cls-${grade}` : "",
      node.side === "black" ? "is-black" : "is-white",
    ].filter(Boolean),
    suffix: glyph ? html`<i class="mtree-glyph">${glyph}</i>` : "",
    title: label,
    label,
  };
}


const GRADE_CLASSES = ["brilliant", "great", "best", "excellent", "good", "book", "forced", "inaccuracy", "mistake", "blunder", "missed_win", "missed_tactic"];

function paintToken(token, node) {
  const deco = moveDecoration(node);
  const grade = nodeGrade(node);
  for (const name of GRADE_CLASSES) token.classList.toggle(`cls-${name}`, grade === name);
  let glyph = token.querySelector?.(".mtree-glyph");
  const glyphHtml = String(deco.suffix || "");
  if (glyphHtml && glyph) glyph.outerHTML = glyphHtml;
  else if (glyphHtml) token.querySelector?.(".mtree-san")?.insertAdjacentHTML?.("afterend", glyphHtml);
  else glyph?.remove?.();
  token.title = deco.title;
  const san = token.querySelector?.(".mtree-san")?.textContent || node.san;
  const num = node.moveNumber == null ? "" : `${node.moveNumber}${node.side === "black" ? "..." : "."}`;
  token.setAttribute("aria-label", [`${num} ${san}`, node.side === "black" ? "Black" : "White", deco.label].filter(Boolean).join(", "));
}

// A live grade landing after the tree rendered updates the selected head and
// the affected token only; stepping through moves must not rebuild the sheet.
export function paintVariationGrade(analysisState, plates, changed = null) {
  plates.paintMoveHead(analysisState);
  const tree = analysisState.analysisTree;
  if (!tree || typeof document === "undefined") return;
  const nodes = changed
    ? [...tree.byId.values()].filter((node) => node.fenBefore === changed.fenBefore && node.uci === changed.uci)
    : [tree.byId.get(analysisState.analysisCurrentNodeId)].filter(Boolean);
  for (const node of nodes) {
    const token = document.querySelector?.(`#analysis-moves [data-node-id="${node.id}"]`);
    if (token) paintToken(token, node);
  }
}
