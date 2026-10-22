import { html } from "../html.js";
import { appState, notices } from "../core/state.js";
import { api, setStatus } from "../core/api.js";
import { showInputModal } from "../core/modals.js";
import { effectiveMaiaRating, effectiveStockfishDepth, maiaAnalysisEnabled } from "../core/prefs.js";
import { boardAfterMove, parseFenBoard, pieceSvg } from "../board/ui.js";
import { rememberHandoff } from "../handoff-context.js";
import { openSourceComposer, resolveFetchUsernames, sameFetchSources, selectionChips } from "./shared/source-composer.js";
import { readSourceStore, writeSourceStore } from "./shared/source-store.js";

// Scout: the opponent scouting report, its source tray and the Start guard that
// covers the few milliseconds before the report chunk is bound. The source
// tray is here because the tray and the report are one concern; the shell
// paints it at boot through the lazy wrappers below.
//
// The Source Composer model is shared with Games —
// { linkedMode, accountIds, external } with the shared persistence bridge.
// "all" = Self (every linked identity); "subset" = exactly the listed linked
// ids; "none" = no linked accounts. External Lichess usernames ride alongside
// on both pages. Page difference lives only in the analysis workflow after
// picking, never in the picker.

let requireSignIn, switchView, editRepertoire, createRepertoirePrompt, buildProvisionalNode,
  hardFlushBuild, selectBuildNode, resolveBuildId, setBuildSync, queueBuildAdd, loadPgnIntoAnalyze,
  startLichessOAuth, lichessAccounts;

export function createScoutController(deps) {
  ({ requireSignIn, switchView, editRepertoire, createRepertoirePrompt, buildProvisionalNode,
    hardFlushBuild, selectBuildNode, resolveBuildId, setBuildSync, queueBuildAdd, loadPgnIntoAnalyze,
    startLichessOAuth, lichessAccounts } = deps);

const SCOUT_SOURCE_KEY = "prepforge.scout_source";
// Scout is about the opponent, so an unset Scout selection starts empty: the
// shared default ("Self", used by Games) made Start scout the user's own games.
const SCOUT_SOURCE_DEFAULT = { linkedMode: "none", accountIds: [], external: [] };

function scoutSelection() {
  return readSourceStore(SCOUT_SOURCE_KEY, SCOUT_SOURCE_DEFAULT);
}

function writeScoutSelection(selection) {
  const before = scoutPickedUsernames();
  writeSourceStore(SCOUT_SOURCE_KEY, selection);
  // A report scouted from other accounts would sit under chips that no longer
  // describe it; drop it so the next Start reflects the picked sources.
  if (scoutView && !sameFetchSources(before, scoutPickedUsernames())) scoutView.discardReport();
}

function openScoutComposer(anchor) {
  return openSourceComposer({
    anchor,
    selection: scoutSelection(),
    linkedAccounts: lichessAccounts(),
    allowExternal: true,
    title: "Scout sources",
    externalPlaceholder: "Add Lichess username…",
    onChange: (sel) => {
      writeScoutSelection(sel);
      paintScoutSource();
    },
    onClose: () => paintScoutSource(),
  });
}

function scoutPickedUsernames() {
  return resolveFetchUsernames({
    selection: scoutSelection(),
    linkedAccounts: lichessAccounts(),
    includeExternal: true,
  });
}

function paintScoutSource() {
  const tray = document.getElementById("scout-source-chips");
  if (!tray) return;
  const selection = scoutSelection();
  const { chips, selfState } = selectionChips(selection, lichessAccounts());
  const linked = lichessAccounts();
  const visible = chips.length
    ? chips
    : linked.length && selfState === "all"
      ? [{ kind: "self", label: `Self · ${linked.length} linked account${linked.length === 1 ? "" : "s"}`, count: linked.length }]
      : [];
  tray.hidden = false;
  tray.innerHTML = visible.length
    ? html`${visible
        .map((c) =>
          c.kind === "external"
            ? html`<span class="src-chip" data-scout-chip="${c.id}">${c.label}<button type="button" class="src-chip-x" data-scout-unpick-external="${c.id}" aria-label="Remove ${c.label} from Scout sources">×</button></span>`
            : c.kind === "self"
              ? html`<span class="src-chip is-self" data-scout-chip-self>${c.label}</span>`
              : html`<span class="src-chip" data-scout-chip="${c.id}">${c.label}${c.primary ? html` <span class="conn-primary">Primary</span>` : ""}<button type="button" class="src-chip-x" data-scout-unpick="${c.id}" aria-label="Remove ${c.label} from Scout sources">×</button></span>`
        )}`
    : html`<span class="src-empty">No sources — open Add and pick one</span>`;
  // The empty state names the next step for where the user actually is. While the
  // session is unread it says nothing: a guest/signed-in distinction is a guess.
  const hint = document.getElementById("scout-empty-hint");
  if (hint) {
    hint.textContent = !appState.authKnown
      ? ""
      : !appState.signedIn
        ? "Sign in, add a Lichess username, then Start."
        : visible.length
          ? "Press Start."
          : linked.length
            ? "Add a Lichess username or pick Self, then Start."
            : "Add a Lichess username as a source, then Start.";
  }
}

function bindScoutSource() {
  document.getElementById("scout-source-add")?.addEventListener("click", (event) => {
    if (!requireSignIn("Sign in to scout an opponent", "scout-start")) return;
    openScoutComposer(event?.currentTarget || document.getElementById("scout-source-add"));
  });
  document.getElementById("scout-source-chips")?.addEventListener("click", (event) => {
    const unpickExt = event.target.closest("[data-scout-unpick-external]");
    if (unpickExt) {
      const sel = scoutSelection();
      writeScoutSelection({
        linkedMode: sel.linkedMode,
        accountIds: sel.accountIds,
        external: sel.external.filter((n) => n !== unpickExt.dataset.scoutUnpickExternal),
      });
      paintScoutSource();
      return;
    }
    const unpick = event.target.closest("[data-scout-unpick]");
    if (!unpick) return;
    const sel = scoutSelection();
    const current =
      sel.linkedMode === "all" ? lichessAccounts().map((a) => a.id) : sel.accountIds;
    const rest = current.filter((id) => id !== unpick.dataset.scoutUnpick);
    if (!rest.length && sel.linkedMode === "all") {
      writeScoutSelection({ linkedMode: "none", accountIds: [], external: sel.external });
    } else {
      writeScoutSelection({ linkedMode: "subset", accountIds: rest, external: sel.external });
    }
    paintScoutSource();
  });
  paintScoutSource();
}


// ----- Opponent scouting (Replay tab) — lazy view chunk -----------------------
let scoutModulePromise = null;
let scoutView = null;

function preloadScoutView() {
  if (!scoutModulePromise) {
    scoutModulePromise = import("./scout.js").catch((err) => {
      scoutModulePromise = null;
      throw err;
    });
  }
  return scoutModulePromise;
}

async function ensureScoutView() {
  const mod = await preloadScoutView();
  if (!scoutView) {
    scoutView = mod.createScoutView({
      setStatus,
      switchView,
      api,
      showInputModal,
      createRepertoirePrompt,
      editRepertoire,
      boardAfterMove,
      buildProvisionalNode,
      hardFlushBuild,
      selectBuildNode,
      resolveBuildId,
      setBuildSync,
      notices,
      parseFenBoard,
      pieceSvg,
      getBuildState: () => appState.build,
      getBuildNodeById: (id) => appState.buildNodeById.get(id),
      queueBuildAdd,
      connectLichess: startLichessOAuth,
      loadPgnIntoAnalyze,
      rememberHandoff,
      effectiveMaiaRating,
      maiaAnalysisEnabled: () => maiaAnalysisEnabled(),
      scoutPickedUsernames: () => scoutPickedUsernames(),
      requireSignIn,
      getLichessUsername: () => appState.lichessUsername,
      getLichessAccounts: () => lichessAccounts(),
      effectiveStockfishDepth,
    });
  }
  return scoutView;
}


// Bind the view and let it paint the section's current state. The chunk is
// already in flight by the time Scout is shown, so this only resolves it.
async function ensureScoutUi() {
  const view = await ensureScoutView();
  view.bindControls();
  view.onShow?.();
  return view;
}

let scoutUiPromise = null;
function preloadScoutUi() {
  if (!scoutUiPromise) {
    scoutUiPromise = ensureScoutUi().catch((err) => {
      scoutUiPromise = null;
      throw err;
    });
  }
  return scoutUiPromise;
}

  return {
    scoutSelection, writeScoutSelection, paintScoutSource, bindScoutSource,
    ensureScoutView, preloadScoutUi,
    // The linked-account list changed: the open report re-reads its sources.
    syncSources: () => scoutView?.syncSources(),
    onMaiaGate: () => scoutView?.onMaiaGate(),
  };
}
