// app.js plus the session modules it lazy-loads, as one source text (LF line endings).
// Tests that run real app functions extracted from source read this, so moving code
// between app.js and a lazy module doesn't change what they find.
import { readFileSync } from "node:fs";

const FILES = [
  "./app.js",
  "./core/state.js",
  "./core/api.js",
  "./core/prefs.js",
  "./core/modals.js",
  "./core/engine.js",
  "./coach/coach-loader.js",
  "./board/ui.js",
  "./controllers/engine-widget.js",
  "./notices.js",
  "./board/board-controller.js",
  "./engine-eval.js",
  "./controllers/train-session.js",
  "./controllers/sync.js",
  "./controllers/build-session.js",
  "./controllers/analyze-session.js",
  "./views/teams-controller.js",
  "./views/games-controller.js",
  "./views/scout-controller.js",
  "./views/settings-controller.js",
  "./account-entry.js",
  "./build-entry.js",
  "./palette.js",
  "./train-entry.js",
  "./undo.js",
  "./controllers/analyze-entry.js",
  "./views/shared/source-store.js",
];

export function appSource() {
  return FILES
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n"))
    .join("\n");
}
