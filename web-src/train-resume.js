// Map a /api/train/start or /api/train/smart/start payload onto the Train UI
// session. `fresh` is the flag the client sent: a fresh start always begins
// at queue position 0; a resume keeps the server's session id + card/line index.

function asInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function emptyStats() {
  return { correct: 0, mistakes: 0, streak: 0, best: 0, history: [], lastStreak: 0 };
}

export function isSmartPayload(payload) {
  return String((payload && payload.mode) || "") === "smart" || Array.isArray(payload && payload.cards);
}

/**
 * Unfinished session continues at the server's queue position. An explicit
 * fresh start always presents a new in-memory session at index 0.
 */
export function mapTrainUiSession(payload, { fresh = false } = {}) {
  if (!payload || typeof payload !== "object") {
    throw new Error("train payload required");
  }
  const smart = isSmartPayload(payload);
  const queue = smart
    ? (payload.cards || []).filter((card) => card && Array.isArray(card.targets) && card.targets.length)
    : payload.lines || [];
  const total = smart
    ? asInt(payload.total_cards, queue.length)
    : asInt(payload.prompt && payload.prompt.total_lines, queue.length);
  const serverIndex = smart
    ? asInt(payload.card_index, 0)
    : asInt(payload.prompt && payload.prompt.current_index, 0);
  const lastIndex = Math.max(0, (queue.length || total) - 1);
  const cardIndex = fresh ? 0 : Math.min(serverIndex, lastIndex);
  const resumed = !fresh && (payload.resumed === true || serverIndex > 0);
  return {
    mode: smart ? "smart" : payload.mode || "all_lines",
    sessionId: payload.session_id,
    repertoireId: payload.repertoire_id,
    repertoireName: payload.repertoire_name,
    color: payload.color === "black" ? "black" : "white",
    mixed: !!payload.mixed,
    queue,
    cardIndex: queue.length ? Math.min(cardIndex, queue.length - 1) : 0,
    targetIndex: 0,
    totalCards: queue.length || total,
    counts: payload.counts ? { ...payload.counts } : null,
    healthBefore: payload.health || null,
    prompt: payload.prompt || null,
    resumed,
    stats: emptyStats(),
    cardsDone: fresh ? 0 : serverIndex,
    seed: payload.seed,
    lineOrder: payload.line_order || null,
  };
}

export function shouldResetTrainStats(mapped) {
  return !mapped || !mapped.resumed;
}
