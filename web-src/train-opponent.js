// Opponent-reply picker for Play vs human. Pure: explorer rows / repertoire
// children / Maia policy + legal UCIs in, one UCI out. No DOM, no network.

export const EXPLORER_THIN_SAMPLE = 8;

function legalSet(legalUcis) {
  return new Set((legalUcis || []).map((uci) => String(uci).toLowerCase()));
}

function roll(rng) {
  const value = typeof rng === "function" ? rng() : Math.random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.999999, Math.max(0, value));
}

function pickWeighted(items, weightOf, rng) {
  const scored = [];
  let total = 0;
  for (const item of items || []) {
    const weight = Number(weightOf(item));
    if (!Number.isFinite(weight) || weight <= 0) continue;
    scored.push({ item, weight });
    total += weight;
  }
  if (!scored.length || total <= 0) return null;
  let cursor = roll(rng) * total;
  for (const row of scored) {
    cursor -= row.weight;
    if (cursor <= 0) return row.item;
  }
  return scored[scored.length - 1].item;
}

export function pickExplorerReply(explorer, legalUcis, rng = Math.random) {
  const legal = legalSet(legalUcis);
  const moves = ((explorer && explorer.moves) || []).filter((move) =>
    legal.has(String(move.uci || "").toLowerCase()),
  );
  const picked = pickWeighted(moves, (move) => Number(move.share) || Number(move.total) || 0, rng);
  return picked ? picked.uci : null;
}

export function pickMaiaReply(predictions, legalUcis, rng = Math.random) {
  const legal = legalSet(legalUcis);
  const moves = (predictions || []).filter((row) =>
    legal.has(String(row && row.move_uci ? row.move_uci : "").toLowerCase()),
  );
  const picked = pickWeighted(moves, (row) => Number(row.probability) || 0, rng);
  return picked ? picked.move_uci : null;
}

export function pickRepertoireReply(children, legalUcis, rng = Math.random) {
  const legal = legalSet(legalUcis);
  const kids = (children || [])
    .map((child) => (typeof child === "string" ? child : child && child.uci))
    .filter((uci) => legal.has(String(uci || "").toLowerCase()));
  if (!kids.length) return null;
  const index = Math.min(kids.length - 1, Math.floor(roll(rng) * kids.length));
  return kids[index];
}

/**
 * Choose the opponent's next move.
 * book: "repertoire" | "explorer" | "maia"
 * Explorer below EXPLORER_THIN_SAMPLE games falls back to Maia for that ply only.
 * Repertoire only returns a child of the current node (Maia if the node has none).
 */
export function pickOpponentReply({
  book = "maia",
  legalUcis = [],
  explorer = null,
  repertoireChildren = [],
  maiaPredictions = [],
  rng = Math.random,
} = {}) {
  const maiaOrNone = (reason) => {
    const uci = pickMaiaReply(maiaPredictions, legalUcis, rng);
    if (uci) return { uci, source: "maia", reason: reason || null };
    return { uci: null, source: "none", reason: reason || "no-move" };
  };

  if (book === "repertoire") {
    const uci = pickRepertoireReply(repertoireChildren, legalUcis, rng);
    if (uci) return { uci, source: "repertoire", reason: null };
    return maiaOrNone("out-of-book");
  }

  if (book === "explorer") {
    const total = Number(explorer && explorer.totalGames) || 0;
    if (total < EXPLORER_THIN_SAMPLE) return maiaOrNone("thin-sample");
    const uci = pickExplorerReply(explorer, legalUcis, rng);
    if (uci) return { uci, source: "explorer", reason: null };
    return maiaOrNone("no-legal-explorer-move");
  }

  return maiaOrNone(null);
}

/** After an opponent UCI is applied, decide whether the play session is over. */
export function playPositionAfterReply(board) {
  const status = (board && board.status) || {};
  const mate = !!status.is_checkmate;
  const stale = !!status.is_stalemate;
  if (mate || stale) {
    return {
      terminal: true,
      active: false,
      legalMoves: [],
      banner: mate ? "Checkmate" : "Draw",
    };
  }
  return {
    terminal: false,
    active: true,
    legalMoves: (board && board.legal_moves) || [],
    banner: null,
  };
}
