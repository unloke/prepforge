// Build ⋯ → Add lines from PGN…: asks for a PGN, plans the merge in the browser
// (build-pgn-merge.js) and queues the new moves on the local-first Build outbox
// exactly as played moves are queued. No request of its own: the outbox saves.
import { showInputModal } from "../core/modals.js";
import { buildState } from "../core/state.js";
import { setStatus } from "../core/api.js";
import { buildProvisionalNode, isBuildReadOnly, queueBuildAdd, renderBuilderTree, setBuildSync } from "../build-entry.js";
import { commitPendingUndos } from "../undo.js";
import { persistence } from "../core/app-context.js";
import { planPgnMerge, pgnMergeSummary } from "../build-pgn-merge.js";

const { scheduleBuildFlush } = persistence;

// Queue a plan's moves in order; a move whose parent is planned too takes that
// parent's fresh provisional node.
export function applyPgnMergePlan(plan) {
  const added = [];
  for (const move of plan.moves) {
    const parent = move.parentId ? buildState.buildNodeById.get(move.parentId) : added[move.parentIndex];
    const node = buildProvisionalNode(parent, move.uci, move.after);
    queueBuildAdd(node);
    added.push(node);
  }
  return added;
}

// "Choose file…" fills the PGN box from a local file; the dialog stays open.
function addFilePicker(overlay) {
  const footer = overlay.querySelector(".modal-footer");
  if (!footer || footer.querySelector('[data-action="choose-file"]')) return;
  const input = Object.assign(document.createElement("input"), {
    type: "file", accept: ".pgn,application/x-chess-pgn,text/plain", hidden: true,
  });
  const button = Object.assign(document.createElement("button"), {
    type: "button", className: "btn ghost", textContent: "Choose file…",
  });
  button.dataset.action = "choose-file";
  button.addEventListener("click", () => {
    input.value = "";
    input.click();
  });
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    const area = overlay.querySelector('textarea[name="pgn"]');
    if (!file || !area) return;
    const errorEl = overlay.querySelector("[data-form-error]");
    try {
      area.value = await file.text();
      if (errorEl) errorEl.hidden = true;
    } catch {
      if (errorEl) {
        errorEl.textContent = "Couldn't read that file";
        errorEl.hidden = false;
      }
    }
  });
  footer.prepend(button, input);
}

export async function promptBuildPgnMerge() {
  if (isBuildReadOnly()) {
    setStatus("Read-only — copy to your account to edit");
    return;
  }
  const repertoireId = buildState.build?.repertoire_id;
  if (!repertoireId) {
    setStatus("Open a repertoire first");
    return;
  }
  const plan = await showInputModal({
    title: "Add lines from PGN",
    okLabel: "Add moves",
    fields: [
      { name: "pgn", label: "PGN", type: "textarea", default: "" },
      { name: "moves-only", type: "note", label: "Only the moves are added, not comments or arrows." },
    ],
    onInput: (_values, overlay) => addFilePicker(overlay),
    onSubmit: (values, close) => {
      if (buildState.build?.repertoire_id !== repertoireId || isBuildReadOnly()) {
        throw new Error("The repertoire changed. Reopen it and try again.");
      }
      const text = (values.pgn || "").trim();
      if (!text) throw new Error("Paste a PGN or choose a file.");
      const planned = planPgnMerge(buildState.build.nodes, text);
      if (!planned.ok) throw new Error(planned.error);
      if (planned.moves.length) {
        // A delete still inside its undo window has left the tree but not the
        // outbox. Close the windows first so those deletes flush before these
        // adds, as onBuildBoardMove does for a replayed move: otherwise the
        // server merges a re-added move into the node about to be deleted.
        commitPendingUndos();
        applyPgnMergePlan(planned);
      }
      close(planned);
    },
  });
  if (!plan) return;
  if (plan.moves.length) {
    renderBuilderTree();
    setBuildSync("dirty");
    scheduleBuildFlush();
  }
  setStatus(pgnMergeSummary(plan));
}
