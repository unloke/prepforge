import { html } from "./html.js";
import { modalDialog, openModal } from "./core/dialog.js";
import "./shortcuts-help.css";

// The keyboard list `?` opens, as Lichess's does (loaded on the first `?`): the keys of the board on
// screen, then the app's own. One table, so the list and the handlers in
// app.js are read side by side when either changes.
export const SHORTCUTS = {
  analyze: [
    ["← →", "Previous / next move"],
    ["↑ ↓ · Home End", "First / last move"],
    ["Shift ← →", "Previous / next key moment"],
    ["F", "Flip the board"],
  ],
  build: [
    ["← →", "Previous / next move"],
    ["Home End", "Start / end of the line"],
    ["↑ ↓ · J K", "Pick the next prepared move"],
    ["F", "Flip the board"],
    ["Ctrl Z", "Take back the last move added"],
  ],
  train: [["F", "Flip the board"]],
  any: [
    ["Ctrl K", "Search and jump"],
    ["?", "This list"],
  ],
};

export function shortcutRows(view) {
  return [...(SHORTCUTS[view] || []), ...SHORTCUTS.any];
}

let close = null;
export function toggleShortcutsHelp(view) {
  if (close?.dialog?.open) return void close();
  const dialog = modalDialog("shortcuts-modal");
  dialog.innerHTML = html`
    <h2 class="modal-title">Keyboard</h2>
    <dl class="modal-body shortcut-list">
      ${shortcutRows(view).map(([keys, what]) => html`<dt>${keys.split(" ").map((k) => (k === "·" ? html`<span>or</span>` : html`<kbd>${k}</kbd>`))}</dt><dd>${what}</dd>`)}
    </dl>`;
  close = openModal(dialog);
}
