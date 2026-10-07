// app.js plus the session modules it lazy-loads, as one source text (LF line endings).
// Tests that run real app functions extracted from source read this, so moving code
// between app.js and a lazy module doesn't change what they find.
import { readFileSync } from "node:fs";

const FILES = [
  "./app.js",
  "./controllers/engine-widget.js",
  "./controllers/toast-stack.js",
  "./board/board-controller.js",
  "./engine-eval.js",
  "./controllers/train-session.js",
  "./controllers/sync.js",
  "./controllers/build-session.js",
  "./controllers/analyze-session.js",
];

export function appSource() {
  return FILES
    .map((path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n"))
    .join("\n");
}
