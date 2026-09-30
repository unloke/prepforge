// Analyze checkpoint store (F-03/F-04).
//
// A full-game analysis spends minutes of engine/model compute BEFORE the one
// classify-save write. If that write fails (network drop, expired session,
// refresh) the work used to be gone. This store keeps the computed result on
// the device, keyed by OWNER + game identity, so the user can retry just the
// SAVE — never the analysis — and a page reload can pick the work back up.
//
// Owner scoping matters: the keys are per account, so signing in as B never
// offers to "retry save" A's pending analysis, and a shared machine does not
// leak one account's game list to another. When no game id is given, the
// NEWEST checkpoint for this owner wins (the one the user just lost), instead
// of whichever key happened to be stored first.

const KEY_PREFIX = "prepforge.analyze_checkpoint.v2.";
// Checkpoints hold per-position evals (small) but Maia assessments too; a
// generous cap keeps localStorage from filling up on a huge game.
const MAX_CHARS = 4_000_000;

function ownerSegment(ownerId) {
  return ownerId || "anon";
}

function indexKey(ownerId) {
  return `${KEY_PREFIX}index.${ownerSegment(ownerId)}`;
}

export function checkpointKey(gameId, ownerId) {
  return `${KEY_PREFIX}${ownerSegment(ownerId)}.${gameId || "anon"}`;
}

function readJson(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

/** Stored game ids for one owner, newest first. */
export function listCheckpointGames(ownerId) {
  const index = readJson(localStorage.getItem(indexKey(ownerId))) || {};
  return Object.keys(index)
    .map((gameId) => ({ gameId, savedAt: Number(index[gameId]) || 0 }))
    .sort((a, b) => b.savedAt - a.savedAt);
}

function writeIndex(ownerId, entries) {
  const kept = {};
  for (const { gameId, savedAt } of entries.sort((a, b) => b.savedAt - a.savedAt).slice(0, 50)) {
    kept[gameId] = savedAt;
  }
  localStorage.setItem(indexKey(ownerId), JSON.stringify(kept));
}

/**
 * Persist one finished-but-unsaved analysis.
 * @param {{gameId: string, ownerId?: string, engine?: string, depth?: number,
 *          positions: string[], evals: Array<[string, object]>,
 *          maiaAssessments?: object[], pgn?: string, savedAt?: number}} checkpoint
 */
export function saveCheckpoint(checkpoint) {
  const ownerId = checkpoint.ownerId;
  try {
    const payload = {
      gameId: checkpoint.gameId,
      ownerId: ownerId || null,
      engine: checkpoint.engine,
      depth: checkpoint.depth,
      positions: checkpoint.positions || [],
      evals: checkpoint.evals || [],
      maiaAssessments: checkpoint.maiaAssessments || [],
      pgn: checkpoint.pgn || "",
      savedAt: checkpoint.savedAt || Date.now(),
    };
    const text = JSON.stringify(payload);
    if (text.length > MAX_CHARS) return false;
    localStorage.setItem(checkpointKey(checkpoint.gameId, ownerId), text);
    const index = readJson(localStorage.getItem(indexKey(ownerId))) || {};
    index[checkpoint.gameId] = payload.savedAt;
    writeIndex(ownerId, Object.keys(index).map((gameId) => ({ gameId, savedAt: index[gameId] })));
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * The stored checkpoint for a game (or this owner's most recent one when the
 * id is omitted). Owner-scoped: another account's work is invisible here.
 */
export function loadCheckpoint(gameId, ownerId) {
  try {
    if (gameId) {
      return readJson(localStorage.getItem(checkpointKey(gameId, ownerId)));
    }
    const [newest] = listCheckpointGames(ownerId);
    return newest ? readJson(localStorage.getItem(checkpointKey(newest.gameId, ownerId))) : null;
  } catch (_) {
    return null;
  }
}

/** Drop the checkpoint once the save is confirmed (or the user discards it). */
export function clearCheckpoint(gameId, ownerId) {
  try {
    localStorage.removeItem(checkpointKey(gameId, ownerId));
    const index = readJson(localStorage.getItem(indexKey(ownerId))) || {};
    delete index[gameId];
    writeIndex(ownerId, Object.keys(index).map((id) => ({ gameId: id, savedAt: index[id] })));
  } catch (_) {
    /* ignore */
  }
}

/** Eval pairs → the fen-keyed map the classify-save payload builder wants. */
export function evalMapFrom(checkpoint) {
  const map = new Map();
  for (const entry of (checkpoint && checkpoint.evals) || []) {
    if (Array.isArray(entry) && entry.length === 2) map.set(entry[0], entry[1]);
  }
  return map;
}