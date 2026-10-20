import { normalizeSelection } from "./source-composer.js";

// The Source Composer's selection model is pure; this is where a page keeps it
// between visits. One stored object per page key (Games, Scout), so a pick on
// one page never edits the other's.
export function readSourceStore(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return normalizeSelection(raw == null ? fallback : JSON.parse(raw));
  } catch (_) {
    return normalizeSelection(fallback);
  }
}

export function writeSourceStore(key, selection) {
  try {
    localStorage.setItem(key, JSON.stringify(normalizeSelection(selection)));
  } catch (_) { /* storage unavailable */ }
}
