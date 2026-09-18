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

/**
 * Merge legal children from every active repertoire by UCI.
 *
 * The returned rows retain the source repertoire names/ids so the Play UI can
 * explain which preparation answered. Every deduplicated UCI is one equally
 * likely coverage candidate: a move appearing in several repertoires does not
 * gain extra tickets.
 */
export function mergeRepertoireReplies(children, legalUcis) {
  const legal = legalSet(legalUcis);
  const merged = new Map();
  for (const child of children || []) {
    const rawUci = typeof child === "string" ? child : child && child.uci;
    const uci = String(rawUci || "").toLowerCase();
    if (!uci || !legal.has(uci)) continue;
    const row = typeof child === "string" ? {} : child || {};
    const source = {
      id: row.repertoireId ?? row.repertoire_id ?? row.id ?? null,
      name: row.repertoireName ?? row.repertoire_name ?? row.name ?? null,
      color: row.color ?? null,
    };
    let item = merged.get(uci);
    if (!item) {
      item = { uci, weight: 1, repertoires: [] };
      merged.set(uci, item);
    }
    // A caller may pass more than one node from the same repertoire (for
    // example a transposition). Keep the source list readable and deterministic.
    const duplicate = item.repertoires.some(
      (rep) =>
        (rep.id && source.id && rep.id === source.id) ||
        (!rep.id && !source.id && rep.name && source.name && rep.name === source.name),
    );
    if (!duplicate) item.repertoires.push(source);
  }
  return [...merged.values()];
}

function pickRepertoireReplyDetail(children, legalUcis, rng = Math.random) {
  const merged = mergeRepertoireReplies(children, legalUcis);
  if (!merged.length) return null;
  const index = Math.min(merged.length - 1, Math.floor(roll(rng) * merged.length));
  return merged[index] || merged[0];
}

export function pickRepertoireReply(children, legalUcis, rng = Math.random) {
  const picked = pickRepertoireReplyDetail(children, legalUcis, rng);
  return picked ? picked.uci : null;
}

/**
 * Choose the opponent's next move.
 * book: "repertoire" | "explorer" | "maia"
 * Explorer below EXPLORER_THIN_SAMPLE games falls back to Maia for that ply only.
 * My repertoire treats all active repertoires as one equally likely coverage
 * book. When the merged book has no legal reply, Explorer gets the next
 * chance; Maia is the final fallback when Explorer is thin/unavailable.
 */
export function pickOpponentReply({
  book = "maia",
  legalUcis = [],
  explorer = null,
  repertoireChildren = [],
  repertoireReplies = [],
  maiaPredictions = [],
  rng = Math.random,
} = {}) {
  const maiaOrNone = (reason) => {
    const uci = pickMaiaReply(maiaPredictions, legalUcis, rng);
    if (uci) return { uci, source: "maia", reason: reason || null };
    return { uci: null, source: "none", reason: reason || "no-move" };
  };

  if (book === "repertoire") {
    const detail = pickRepertoireReplyDetail(
      repertoireReplies.length ? repertoireReplies : repertoireChildren,
      legalUcis,
      rng,
    );
    if (detail) {
      const names = detail.repertoires.map((rep) => rep.name).filter(Boolean);
      const ids = detail.repertoires.map((rep) => rep.id).filter(Boolean);
      return {
        uci: detail.uci,
        source: "repertoire",
        reason: null,
        repertoireId: ids[0] || null,
        repertoireName: names[0] || null,
        repertoireNames: names,
      };
    }
    const total = Number(explorer && explorer.totalGames) || 0;
    if (total >= EXPLORER_THIN_SAMPLE) {
      const uci = pickExplorerReply(explorer, legalUcis, rng);
      if (uci) return { uci, source: "explorer", reason: "out-of-book" };
    }
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
