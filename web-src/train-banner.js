// Train's coach banner and turn badge: the card's prompt, verdict and hint
// lines, and which side is to move. Drawn by the session, its home and the view.
import { START_FEN, trainState } from "./core/state.js";
import { pieceSvg } from "./board/ui.js";
import { moveTextHtml, walkPathText } from "./move-text.js";

// Right pops its tick, wrong nudges, a hint only brings its line in.
const BANNER_MOTION = new Set(["correct", "wrong", "move"]);
export function setTrainBanner(state, title, sub) {
  const banner = document.getElementById("train-banner");
  if (!banner) return;
  banner.dataset.state = state;
  const titleEl = document.getElementById("train-banner-title");
  const subEl = document.getElementById("train-banner-sub");
  // The coach's moves peek (Train never plays them); "1...c6" reads along the card's line.
  const path = walkPathText(trainState.smart?.prompt?.target?.line);
  const ctx = { fen: trainState.smart?.prompt?.fen_before, at: (ply) => (ply ? path?.plies[ply - 1]?.fen : START_FEN) };
  titleEl.innerHTML = moveTextHtml(title || "", { ...ctx, pawns: true });
  titleEl.title = title || "";
  subEl.innerHTML = moveTextHtml(sub || "", ctx);
  subEl.title = sub || "";
  banner.classList.remove("flash");
  if (!BANNER_MOTION.has(state)) return;
  banner.querySelector(".train-coach-text").addEventListener("animationend", () => banner.classList.remove("flash"), { once: true });
  requestAnimationFrame(() => banner.classList.add("flash"));
}

export function updateTrainTurnBadge(side) {
  const badge = document.getElementById("train-turn-badge");
  if (!badge) return;
  if (!side) {
    badge.hidden = true;
    badge.innerHTML = "";
    badge.title = "";
    delete badge.dataset.side;
    return;
  }
  badge.hidden = false;
  badge.dataset.side = side;
  badge.title = side === "white" ? "White to move" : "Black to move";
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", badge.title);
  // Show the side-to-move as a real piece (king of that colour), not a bare
  // letter. Pieces are inline SVG (see pieceSvg) — there is no PNG asset.
  badge.innerHTML = pieceSvg(side === "white" ? "K" : "k");
}
