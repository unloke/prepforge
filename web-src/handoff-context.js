// Cross-module handoff context (F-06).
//
// Analyze→Repertoire, Scout→Add to prep, and Games→Train/Analyze already jump
// between modules, but the destination only got a bare payload: the user had to
// re-find the game/line, and nothing remembered WHY the jump happened. This
// module gives every handoff a small, durable task record:
//
// - source game/line (gameId, pgn, lineUcis/lineSans), the ply and anchor FEN
//   the task points at, the user's side, the target repertoire, and the trigger
//   reason;
// - identity is the WHOLE tuple (reason|gameId|rootFen|anchorFen|side|line) so
//   white/black, transposed lines, and different root FENs never interleave, and
//   a repeated click on the same target reuses ONE record instead of piling up
//   duplicates ("practice this mistake" twice is still one task);
// - timestamps (createdAt → takenAt) make the "key mistake → first practice"
//   journey measurable;
// - a return-state slot per view keeps the source page's selected line and
//   filter so coming back restores where you were.
//
// Everything here is pure state plumbing: no DOM, no network. Handoffs live in
// memory (one page session); return state persists to sessionStorage so it
// survives a reload.

const RETURN_PREFIX = "prepforge.return_state.v1.";
const HANDOFF_LOG_CAP = 50;

/** Stable identity for a handoff: same task → same key, no duplicates. */
export function handoffKey({ reason, gameId, rootFen, anchorFen, side, lineUcis }) {
  return [
    reason || "",
    gameId || "",
    rootFen || "",
    anchorFen || "",
    side || "",
    (lineUcis || []).join(" "),
  ].join("|");
}

/**
 * Normalize a handoff input into a record. Unknown fields are dropped; the key
 * and timestamps are derived, never caller-supplied.
 */
export function createHandoff(input = {}) {
  const lineUcis = Array.isArray(input.lineUcis) ? input.lineUcis.map(String) : [];
  const record = {
    source: input.source || "unknown",
    sourceView: input.sourceView || input.source || "unknown",
    reason: input.reason || "unspecified",
    gameId: input.gameId != null ? String(input.gameId) : null,
    pgn: input.pgn || null,
    lineUcis,
    lineSans: Array.isArray(input.lineSans) ? input.lineSans.map(String) : [],
    ply: Number.isFinite(input.ply) ? input.ply : null,
    anchorFen: input.anchorFen || null,
    rootFen: input.rootFen || null,
    side: input.side === "black" ? "black" : input.side === "white" ? "white" : null,
    repertoireId: input.repertoireId != null ? input.repertoireId : null,
    createdAt: Number.isFinite(input.createdAt) ? input.createdAt : Date.now(),
    takenAt: null,
    clicks: 1,
  };
  record.key = handoffKey(record);
  return record;
}

// Pending handoffs, keyed for dedupe. Consumed handoffs move to `settled` so
// the mistake→practice timing stays measurable after the destination takes one.
const pending = new Map();
const settled = [];

function matches(record, match) {
  if (!match) return true;
  if (match.key != null && record.key !== match.key) return false;
  if (match.reason != null && record.reason !== match.reason) return false;
  if (match.source != null && record.source !== match.source) return false;
  if (match.gameId != null && record.gameId !== String(match.gameId)) return false;
  if (match.side != null && record.side !== match.side) return false;
  return true;
}

/**
 * Record a handoff. Repeated clicks on the same target (same key) return the
 * existing record and bump its click count — one task, not a duplicate line.
 */
export function rememberHandoff(input) {
  const record = input && input.key && input.createdAt ? input : createHandoff(input);
  const existing = pending.get(record.key);
  if (existing) {
    existing.clicks += 1;
    return existing;
  }
  pending.set(record.key, record);
  return record;
}

/** Pending (not yet consumed) handoffs, optionally filtered. */
export function pendingHandoffs(match) {
  return [...pending.values()].filter((record) => matches(record, match));
}

/**
 * Take the first pending handoff matching `match` (any record when omitted).
 * The record is stamped takenAt and kept in the (capped) settled log.
 */
export function takeHandoff(match) {
  for (const [key, record] of pending) {
    if (!matches(record, match)) continue;
    pending.delete(key);
    record.takenAt = Date.now();
    settled.push(record);
    if (settled.length > HANDOFF_LOG_CAP) settled.splice(0, settled.length - HANDOFF_LOG_CAP);
    return record;
  }
  return null;
}

/** Drop pending handoffs without touching the settled log. */
export function clearHandoffs() {
  pending.clear();
}

/** Drop the settled journey log (tests / owner switch). */
export function clearHandoffJourney() {
  settled.length = 0;
}

/** All settled handoffs (oldest first) — the measurable journey log. */
export function handoffJourney() {
  return settled.slice();
}

// ----- Return state (source page's selected line + filters) --------------------

/** Persist a view's return state (selected line, filters…) across reloads. */
export function saveReturnState(view, state) {
  try {
    sessionStorage.setItem(RETURN_PREFIX + view, JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}

/** Read a view's saved return state (kept until clearReturnState). */
export function loadReturnState(view) {
  try {
    const raw = sessionStorage.getItem(RETURN_PREFIX + view);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function clearReturnState(view) {
  try {
    sessionStorage.removeItem(RETURN_PREFIX + view);
  } catch (_) {
    /* ignore */
  }
}
