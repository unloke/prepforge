// Stable Analyze node identity: the move sequence from the game's root position.
//
// The tree's own ids (`m<ply>` on the mainline, `v<seq>` for a branch) are
// presentation keys. `v<seq>` is a CREATION counter while the parser numbers a
// reloaded PGN in DEPTH-FIRST order, so the same number can name a different
// branch after a reload: creating 1...d6 first and 2...a6 second saved `v2`, but
// the re-parsed PGN numbered 2...a6 `v1` — the selection came back as the other
// branch, or vanished.
//
// What the user actually selected is a POSITION, and a position is the path that
// leads to it. Persisted selection (session slot and `?node=`) therefore carries
// the full root-to-node UCI path, which both the live tree and a re-parsed PGN
// reproduce exactly:
//
//   root          -> "root"
//   mainline ply N -> first N mainline ucis     "e2e4-e7e5-g1f3"
//   a branch       -> its mainline prefix plus its own branch ucis
//                    "e2e4-d7d6"  /  "e2e4-e7e5-g1f3-a7a6"
//
// `-` separates the moves (a UCI never contains one), so the same string is the
// session value and the `?node=` query value.
//
// An unknown or deleted path resolves to null (the caller keeps the current
// position and says so) — never to an unrelated node that happens to hold the
// same number.

export const ANALYSIS_ROOT_PATH = "root";
const PATH_SEPARATOR = "-";
const UCI_RE = /^[a-h][1-8][a-h][1-8][qrbn]?$/;

// The UCI path from the root to this node, walking its parent chain. Works for a
// node that is not in the tree yet (a branch the user just created carries its
// parent), and for a fallback mainline node that names its own `path`.
export function analysisPathOf(node) {
  if (!node) return null;
  if (node.path) return node.path;
  const ucis = [];
  for (let cursor = node; cursor && cursor.parent; cursor = cursor.parent) {
    if (!cursor.uci) return null;
    ucis.push(cursor.uci);
  }
  return ucis.length ? ucis.reverse().join(PATH_SEPARATOR) : ANALYSIS_ROOT_PATH;
}

// The UCI moves from the root to `nodeId`, or null when the id is not in the tree.
export function analysisNodePath(nodeId, tree) {
  const id = nodeId || ANALYSIS_ROOT_PATH;
  if (id === ANALYSIS_ROOT_PATH) return ANALYSIS_ROOT_PATH;
  const node = tree && tree.byId ? tree.byId.get(id) : null;
  return node ? analysisPathOf(node) : null;
}

// The node with exactly that move sequence, or null when the tree has no such path.
export function analysisNodeIdFromPath(path, tree) {
  const raw = String(path || "").trim();
  if (!raw || !tree || !tree.root) return null;
  if (raw === ANALYSIS_ROOT_PATH) return tree.root.id;
  const ucis = raw.split(PATH_SEPARATOR);
  if (!ucis.every((uci) => UCI_RE.test(uci))) return null;
  let node = tree.root;
  for (const uci of ucis) {
    node = (node.children || []).find((child) => child.uci === uci);
    if (!node) return null;
  }
  return node.id;
}

// Whether a string is a well-formed node path (`root` or UCI moves separated by
// `-`). The URL and session codec use it to reject anything else outright.
export function isAnalysisNodePath(raw) {
  const value = String(raw || "").trim();
  if (value === ANALYSIS_ROOT_PATH) return true;
  if (!value) return false;
  const ucis = value.split(PATH_SEPARATOR);
  return ucis.length > 0 && ucis.every((uci) => UCI_RE.test(uci));
}
