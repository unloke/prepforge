import { appState } from "./core/state.js";
import { api, currentOwnerId, postJson, setStatus, setStatusError } from "./core/api.js";
import { rememberHandoff } from "./handoff-context.js";
import { preloadCoach, _coachReady } from "./coach/coach-loader.js";

// Analyze ↔ repertoire sync ("the book"). The module is lazy; this is the one
// cached copy of the active repertoire trees the Analyze coach walks.
//   - opponent leaves the book → "Add it in Build" inline action at the
//     departure node
//   - the player leaves their own book → "Add to training" records one recall miss
//     (POST /api/train/record-miss) so the move leads the next smart session

let editRepertoire;

export function createBook(deps) {
  ({ editRepertoire } = deps);
  return { invalidateBook, ensureBookLoaded, updateBookline };
}

// ---------------------------------------------------------------------------
// Analyze ↔ repertoire sync ("the book"). Lazily loads the user's ACTIVE
// repertoire trees once per visit and, on every Analyze position change, walks
// the explored move path against them (path-based, like the recap's departure
// detection — transpositions intentionally don't count). The coach only speaks
// on the in-book → out-of-book TRANSITION: if a branch was never prepped the
// in-book state never held, so nothing nags (and in-book shows nothing at all).
//   - opponent leaves the book → "Add it in Build" inline action at the
//     departure node
//   - the player leaves their own book → "Add to training" records one recall miss
//     (POST /api/train/record-miss) so the move leads the next smart session
// ---------------------------------------------------------------------------
const bookState = {
  generation: 0,
  loaded: false,
  loading: null,
  reps: [], // { id, name, color, rootId, children: Map("parentId|uci" -> node), kids: Map(parentId -> [node]) }
};

// Build edits make this copy stale; drop it so the next Analyze look refetches.
export function invalidateBook() {
  bookState.generation++;
  bookState.loaded = false;
  bookState.loading = null;
  bookState.reps = [];
}

let bookActionsPromise = null;
function loadBookActions() {
  bookActionsPromise ||= import("./analyze-book.js").then(({ createBookActions }) => createBookActions({
    bookState, appState, currentOwnerId, api, loadCoach: () => (_coachReady || preloadCoach()),
    rememberHandoff, postJson, setStatus, setStatusError, editRepertoire,
  })).catch((error) => { bookActionsPromise = null; throw error; });
  return bookActionsPromise;
}

export async function ensureBookLoaded() {
  return (await loadBookActions()).ensureBookLoaded();
}

export async function updateBookline() {
  return (await loadBookActions()).updateBookline();
}

