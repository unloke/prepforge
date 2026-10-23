// The review bar's state under the board: which key moment its label shows,
// whether its arrows can move, and which action it offers. Pure, so the view
// only writes the model into the bar and the unit test reads it directly.
import { classBadgeSymbol } from "../move-grades.js";
import { momentKind, reviewState } from "./analyze-report.js";

// The Maia3 model's download (maia3-weights-loader.js: 46 MB).
export const MAIA_DOWNLOAD = "46 MB";

// On a stop where prep was left, the coach line's own action for it: the
// opponent's novelty goes to Build, the user's missed prep is drilled.
export const REVIEW_ACTION = {
  build: "Add to repertoire",
  train: "Add to training",
};

export function reviewBarModel({ moments = [], ply = 0, graded = false, running = false, signedIn = false, maiaOff = false } = {}) {
  if (!moments.length || !graded || running) return { hidden: true };
  const st = reviewState(moments, ply);
  const focus = st.focus;
  const stop = st.current?.departure && st.current.by ? st.current : null;
  // The coach offers the novelty to add, or the prepared move to drill (only when
  // the book had one there); a stop with nothing prepared has no action.
  const act = stop && signedIn && (stop.by === "opponent" || stop.prepared) ? (stop.by === "opponent" ? "build" : "train") : null;
  return {
    hidden: false,
    prevDisabled: !st.prev,
    nextDisabled: !st.next,
    grade: focus?.grade || "none",
    glyph: focus?.grade ? classBadgeSymbol(focus.move?.classification) : "",
    label: focus?.label || "",
    kind: momentKind(focus),
    count: `${st.index + 1}/${st.count}`,
    act,
    actLabel: act ? REVIEW_ACTION[act] : "",
    maia: maiaOff,
  };
}
