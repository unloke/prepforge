import { html } from "./html.js";
import { notices } from "./core/state.js";

// Destructive actions apply to the UI instantly but only reach the server once
// the undo window closes — no type-to-confirm friction, and a mid-window Undo
// costs zero server requests. Commits are forced (commitPendingUndos) before
// anything that needs server truth or before the page goes away.
const UNDO_TOAST_MS = 5000;
const pendingUndoCommits = new Set();

export function showUndoToast({ title, message, onUndo, onCommit, host = null }) {
  if (host) return showInlineUndo(host, { title, message, onUndo, onCommit });
  let settled = false;
  let card = null;
  const commit = () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    try {
      onCommit();
    } catch (_) {
      /* best-effort */
    }
    if (card) card.dismiss();
  };
  pendingUndoCommits.add(commit);
  // Hovering the card pauses the countdown, so the window never closes while
  // the user is reaching for Undo.
  card = notices.show(message, {
    title,
    duration: UNDO_TOAST_MS,
    onClose: commit,
    actions: [
      {
        label: "Undo",
        primary: true,
        onClick: () => {
          if (settled) return;
          settled = true;
          pendingUndoCommits.delete(commit);
          try {
            onUndo();
          } catch (_) {
            /* best-effort */
          }
        },
      },
    ],
  });
  return commit;
}

// One floating undo per host; it never participates in the editor's layout.
// A newer delete commits the previous one. Hover and keyboard focus pause it.
function showInlineUndo(host, { title, message, onUndo, onCommit }) {
  if (host._undoCommit) host._undoCommit();
  let settled = false;
  let timer = null;
  let remaining = UNDO_TOAST_MS;
  let startedAt = 0;
  const close = () => {
    window.clearTimeout(timer);
    if (host._undoCommit === commit) {
      host._undoCommit = null;
      host.hidden = true;
      host.innerHTML = "";
    }
  };
  const commit = () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    close();
    try {
      onCommit();
    } catch (_) {
      /* best-effort */
    }
  };
  const arm = () => {
    window.clearTimeout(timer);
    startedAt = Date.now();
    timer = window.setTimeout(commit, remaining);
  };
  pendingUndoCommits.add(commit);
  host._undoCommit = commit;
  host.innerHTML =
    html`<span class="undo-toast-text"><b>${title}</b>${message ? ` · ${message}` : ""}</span><button type="button" class="btn sm" data-inline-undo>Undo</button>`;
  host.hidden = false;
  host.onpointerenter = () => {
    if (settled || timer === null) return;
    window.clearTimeout(timer);
    timer = null;
    remaining = Math.max(800, remaining - (Date.now() - startedAt));
  };
  host.onpointerleave = () => {
    if (!settled && !host.contains(document.activeElement)) arm();
  };
  host.onfocusin = host.onpointerenter;
  host.onfocusout = () => {
    if (!settled && !host.matches(":hover")) arm();
  };
  host.querySelector("[data-inline-undo]").addEventListener("click", () => {
    if (settled) return;
    settled = true;
    pendingUndoCommits.delete(commit);
    close();
    try {
      onUndo();
    } catch (_) {
      /* best-effort */
    }
  });
  arm();
  return commit;
}

// Close every open undo window NOW. Called before hard flushes (an operation
// needs server truth) and on page hide/unload (the commits use keepalive-safe
// requests where needed).
export function commitPendingUndos() {
  for (const commit of [...pendingUndoCommits]) commit();
}

