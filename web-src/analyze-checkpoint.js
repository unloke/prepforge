// Analyze checkpoint store (F-03).
//
// A full-game analysis spends minutes of engine/model compute BEFORE the one
// classify-save write. If that write fails (network drop, expired session,
// refresh) the work used to be gone. This store keeps the computed result on
// the device, keyed by game identity, so the user can retry just the SAVE —
// never the analysis — and a page reload can pick the work back up.

const KEY_PREFIX = "prepforge.analyze_checkpoint.v1.";
// Checkpoints hold per-position evals (small) but Maia assessments too; a
// generous cap keeps localStorage from filling up on a huge game.
const MAX_CHARS = 4_000_000;

export function checkpointKey(gameId) {
  return KEY_PREFIX + (gameId || "anon");
}

/**
 * Persist one finished-but-unsaved analysis.
 * @param {{gameId: string, engine?: string, depth?: number, positions: string[],
 *          evals: Array<[string, object]>, maiaAssessments?: object[],
 *          pgn?: string, savedAt?: number}} checkpoint
 */
export function saveCheckpoint(checkpoint) {
  try {
    const payload = {
      gameId: checkpoint.gameId,
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
    localStorage.setItem(checkpointKey(checkpoint.gameId), text);
    return true;
  } catch (_) {
    return false;
  }
}

/** The stored checkpoint for a game (or one from any game when id omitted). */
export function loadCheckpoint(gameId) {
  try {
    if (gameId) {
      const raw = localStorage.getItem(checkpointKey(gameId));
      return raw ? JSON.parse(raw) : null;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(KEY_PREFIX)) {
        const raw = localStorage.getItem(key);
        if (raw) return JSON.parse(raw);
      }
    }
    return null;
  } catch (_) {
    return null;
  }
}

/** Drop the checkpoint once the save is confirmed (or the user discards it). */
export function clearCheckpoint(gameId) {
  try {
    localStorage.removeItem(checkpointKey(gameId));
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
