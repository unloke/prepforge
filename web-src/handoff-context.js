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
// No DOM or network. Once configured, pending tasks and the journey persist
// under an owner-scoped key. Legacy unscoped return state is never adopted.

const RETURN_PREFIX = "prepforge.return_state.v1.";
const HANDOFF_LOG_CAP = 50;
const TASK_PREFIX = "prepforge.preparation-tasks.v1.";
let taskOwner = null;

function taskStorageKey() {
  return TASK_PREFIX + encodeURIComponent(taskOwner);
}

function mergeStoredTasks() {
  if (taskOwner === null) return;
  const data = JSON.parse(localStorage.getItem(taskStorageKey()) || "null");
  if (data?.version !== 1) return;
  for (const raw of [...(data.pending || []), ...(data.settled || [])]) {
    const record = { ...createHandoff(raw), ...lifecycleFields(raw), takenAt: raw.takenAt ?? null,
      clicks: Number.isInteger(raw.clicks) ? raw.clicks : 1 };
    const current = pending.get(record.key) || settled.find((item) => item.key === record.key);
    if (current?.takenAt != null || (current && (current.updatedAt || current.createdAt) >= (record.updatedAt || record.createdAt))) continue;
    if (record.takenAt != null) {
      pending.delete(record.key);
      const index = settled.findIndex((item) => item.key === record.key);
      if (index < 0) settled.push(record); else settled[index] = record;
    } else pending.set(record.key, record);
  }
}

function persistTasks() {
  if (taskOwner === null) return;
  try {
    mergeStoredTasks();
    localStorage.setItem(taskStorageKey(), JSON.stringify({
      version: 1, pending: [...pending.values()], settled,
    }));
    return true;
  } catch (_) {
    return false;
  }
}

/** Switch task ownership before a view can read or record source context. */
export function setHandoffOwner(ownerId) {
  taskOwner = String(ownerId || "anon");
  pending.clear();
  settled.length = 0;
  try {
    const data = JSON.parse(localStorage.getItem(taskStorageKey()) || "null");
    if (data?.version !== 1) return;
    for (const raw of Array.isArray(data.pending) ? data.pending : []) {
      const record = createHandoff(raw);
      Object.assign(record, lifecycleFields(raw));
      record.clicks = Number.isInteger(raw.clicks) && raw.clicks > 0 ? raw.clicks : 1;
      pending.set(record.key, record);
    }
    for (const raw of (Array.isArray(data.settled) ? data.settled : []).slice(-HANDOFF_LOG_CAP)) {
      if (!Number.isFinite(raw.takenAt)) continue;
      settled.push({ ...createHandoff(raw), ...lifecycleFields(raw), takenAt: raw.takenAt });
    }
  } catch (_) { /* unavailable storage keeps this owner's in-memory work usable */ }
}

function returnKey(view) {
  return RETURN_PREFIX + (taskOwner === null ? "" : encodeURIComponent(taskOwner) + ".") + view;
}

const TASK_STATES = ["pending", "queued", "prepared", "practicing", "completed", "cancelled"];
function lifecycleFields(input) {
  return {
    status: TASK_STATES.includes(input.status) ? input.status : "pending",
    updatedAt: Number.isFinite(input.updatedAt) ? input.updatedAt : input.createdAt || Date.now(),
    preparedAt: Number.isFinite(input.preparedAt) ? input.preparedAt : null,
    firstPracticeAt: Number.isFinite(input.firstPracticeAt) ? input.firstPracticeAt : null,
    completedAt: Number.isFinite(input.completedAt) ? input.completedAt : null,
    targetNodeIds: Array.isArray(input.targetNodeIds) ? input.targetNodeIds.map(String) : [],
  };
}

/** Stable identity for a handoff: same task → same key, no duplicates. */
export function handoffKey({ reason, gameId, rootFen, anchorFen, side, lineUcis, repertoireId }) {
  return [
    reason || "",
    gameId || "",
    rootFen || "",
    anchorFen || "",
    side || "",
    repertoireId == null ? "" : String(repertoireId),
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
    ...lifecycleFields(input),
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
  if (match.repertoireId != null && String(record.repertoireId) !== String(match.repertoireId)) return false;
  return true;
}

/**
 * Record a handoff. Repeated clicks on the same target (same key) return the
 * existing record and bump its click count — one task, not a duplicate line.
 */
export function rememberHandoff(input) {
  try { mergeStoredTasks(); } catch (_) { /* persistence warning follows below */ }
  const record = input && input.key && input.createdAt ? input : createHandoff(input);
  const existing = pending.get(record.key);
  if (existing) {
    existing.clicks += 1;
    existing.updatedAt = Math.max(Date.now(), existing.updatedAt + 1);
    existing.persisted = persistTasks();
    return existing;
  }
  pending.set(record.key, record);
  record.persisted = persistTasks();
  return record;
}

/** Pending (not yet consumed) handoffs, optionally filtered. */
export function pendingHandoffs(match) {
  try { mergeStoredTasks(); } catch (_) { /* in-memory tasks remain usable */ }
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
    record.status = "completed";
    record.completedAt = record.updatedAt = Math.max(record.takenAt, (record.updatedAt || 0) + 1);
    settled.push(record);
    if (settled.length > HANDOFF_LOG_CAP) settled.splice(0, settled.length - HANDOFF_LOG_CAP);
    persistTasks();
    return record;
  }
  return null;
}

/** Lifecycle transitions; queueing is never counted as first practice. */
export function transitionHandoff(key, status, details = {}) {
  if (!TASK_STATES.includes(status)) throw new Error("Invalid preparation task state");
  try { mergeStoredTasks(); } catch (_) { /* report persist status below */ }
  const record = pending.get(key);
  if (!record) return null;
  const allowed = {
    pending: ["queued", "prepared", "practicing", "cancelled"],
    queued: ["prepared", "practicing", "cancelled"],
    prepared: ["queued", "practicing", "cancelled"],
    practicing: ["completed", "cancelled"],
  };
  if (status !== record.status && !allowed[record.status]?.includes(status)) throw new Error("Invalid preparation task transition");
  const now = Math.max(Date.now(), (record.updatedAt || 0) + 1);
  record.status = status;
  record.updatedAt = now;
  if (details.targetNodeIds) record.targetNodeIds = details.targetNodeIds.map(String);
  if (status === "prepared") record.preparedAt ||= now;
  if (status === "practicing") record.firstPracticeAt ||= now;
  if (status === "completed" || status === "cancelled") {
    record.completedAt = now;
    record.takenAt = now;
    pending.delete(key);
    settled.push(record);
  }
  record.persisted = persistTasks();
  return record;
}

export function trackPreparationPractice({ repertoireId, nodeId, fen, completed = false }) {
  const tasks = pendingHandoffs({ reason: "practice-missed-move" }).filter((task) =>
    String(task.repertoireId) === String(repertoireId) &&
    (task.targetNodeIds.length ? task.targetNodeIds.includes(String(nodeId)) : task.anchorFen === fen));
  for (const task of tasks) {
    transitionHandoff(task.key, "practicing");
    if (completed) transitionHandoff(task.key, "completed");
  }
  return tasks;
}

/** Drop pending handoffs without touching the settled log. */
export function clearHandoffs() {
  pending.clear();
  persistTasks();
}

/** Drop the settled journey log (tests / owner switch). */
export function clearHandoffJourney() {
  settled.length = 0;
  persistTasks();
}

/** All settled handoffs (oldest first) — the measurable journey log. */
export function handoffJourney() {
  return settled.slice();
}

// ----- Return state (source page's selected line + filters) --------------------

/** Persist a view's return state (selected line, filters…) across reloads. */
export function saveReturnState(view, state) {
  try {
    sessionStorage.setItem(returnKey(view), JSON.stringify(state));
    return true;
  } catch (_) {
    return false;
  }
}

/** Read a view's saved return state (kept until clearReturnState). */
export function loadReturnState(view) {
  try {
    const raw = sessionStorage.getItem(returnKey(view));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

export function clearReturnState(view) {
  try {
    sessionStorage.removeItem(returnKey(view));
  } catch (_) {
    /* ignore */
  }
}
