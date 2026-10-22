import { html } from "../html.js";
import { nounOf } from "../plural.js";
import { loadTeamDirectory } from "../team-directory.js";
import { staggerRows } from "../list-enter.js";
import { createLibraryRows } from "./library-rows.js";
// Dashboard tab rendering (lazy-loaded from app.js).

import {
  isPackageJsonFilename,
  MALFORMED_JSON_IMPORT_ERROR,
} from "./import-format.js";

function bindDropZone(element, onFile) {
  if (!element) return;
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  ["dragenter", "dragover"].forEach((type) =>
    element.addEventListener(type, (event) => {
      stop(event);
      element.classList.add("drag-over");
    }),
  );
  ["dragleave", "dragend"].forEach((type) =>
    element.addEventListener(type, (event) => {
      stop(event);
      element.classList.remove("drag-over");
    }),
  );
  element.addEventListener("drop", (event) => {
    stop(event);
    element.classList.remove("drag-over");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) onFile(file);
  });
}

// Library filter bar (prototype All / White / Black / Shared / Disabled plus a
// repertoire name search): a pure client-side predicate over the cached
// /api/repertoires listing. Own rows match on their production fields (name,
// color, shared, is_active); received shared rows carry `sharedRow`. Filtering never refetches or reshapes a row.
export function filterLibraryRows(rows, { filter = "all", query = "" } = {}) {
  const q = query.trim().toLowerCase();
  return (rows || []).filter((item) => {
    if (q && !String(item.name || "").toLowerCase().includes(q)) return false;
    if (filter === "all") return true;
    if (filter === "shared") return item.sharedRow === true || item.shared === true;
    if (filter === "disabled") return item.is_active === false;
    return String(item.color || "") === filter;
  });
}

export function createDashboardView({
  appState,
  api,
  postJson,
  setStatus,
  setStatusError = (message) => setStatus(message),
  localDateString,
  goToSmartTraining,
  editRepertoire,
  openRepertoireContextMenu,
  createRepertoirePrompt,
  hydrateBuild,
  showInputModal,
  promptImportRepertoireFromPgn,
  requireSignIn,
  openSignIn = null,
  onLibraryStateChange = null,
  goToView,
  openSettingsSection = null,
  previewRenderers = null,
}) {
  let eventsBound = false;

  // Library preview selection. The prototype's preview pane is driven by real
  // listing data only: root_fen draws the mini board and the cached health
  // badge fills the mastery mix. One click previews; double-click (or Enter on
  // a selected row) opens the workspace — the full production action.
  let selectedRepId = null;

  // Library filter state (client-side — see filterLibraryRows). Kept across
  // listings so an import or delete doesn't reset the user's filter.
  let libraryFilter = "all";
  let libraryQuery = "";
  let repListCache = { own: [], shared: [] };
  let repListLoaded = false;

  // ---- Painting only what changed -----------------------------------------
  // One load renders each surface twice: the cached team names arrive first
  // (they are already in state), then the fresh /api/repertoires listing. Both
  // writes replaced every node with the same content, which replayed the row
  // entrance over the whole table and rebuilt the Today strip's Train button.
  // Remember the markup each element was given and skip an identical rewrite;
  // the callers that repaint bind their listeners only when a write happened.
  const paintedMarkup = new WeakMap();
  function paint(element, markup) {
    if (!element) return false;
    const next = String(markup ?? "");
    if (paintedMarkup.get(element) === next) return false;
    paintedMarkup.set(element, next);
    element.innerHTML = next;
    return true;
  }
  // A surface written by something other than paint() (the row reconciliation
  // owns its own nodes) drops its note, so the next paint cannot mistake a
  // stale string for what is on screen.
  function forget(element) {
    if (element) paintedMarkup.delete(element);
  }

  // Full loads and mutation refreshes share ownership of the same list/cache.
  let loadSeq = 0;
  function currentLoad(seq) {
    const owner = appState.accountUserId;
    const generation = appState.ownerGeneration;
    return () => seq === loadSeq && owner === appState.accountUserId && generation === appState.ownerGeneration;
  }
  function reportListFailure(message) {
    if (!repListLoaded) renderLibraryListError(message);
    else {
      const status = document.getElementById("library-refresh-status");
      if (status) {
        status.hidden = false;
        status.innerHTML = html`${message} <button class="btn sm" type="button">Retry</button>`;
        status.querySelector("button")?.addEventListener("click", loadDashboardRepertoires);
      }
    }
    setStatusError(message);
  }

  // "Black · 142 moves to train" (+ disabled / shared-with in the preview) —
  // only real listing fields (colour, health.trainable, shared). The
  // listing has no line count or last-trained date, so neither is shown.
  function repSubline(item, { detail = false } = {}) {
    const bits = [String(item.color || "") === "black" ? "Black" : "White"];
    if (item.health && item.health.trainable) {
      // Same wording as the Repertoire header's "· N to train".
      bits.push(`${item.health.trainable} move${item.health.trainable === 1 ? "" : "s"} to train`);
    }
    if (!detail) return bits.join(" · ");
    if (item.is_active === false) bits.push("disabled");
    if (item.shared) bits.push("shared");
    return bits.join(" · ");
  }

  function countBadge(n) {
    const el = document.getElementById("dashboard-rep-count");
    if (!el) return;
    // Signed-in libraries always show their real count (0 included, as in the
    // prototype); null hides it while signed out.
    el.hidden = n == null;
    el.textContent = n == null ? "" : String(n);
  }

  // Setup checklist (signed in). Every step ticks off from state the app
  // already has — repertoire count, linked Lichess identities, finished
  // training sessions — so there is no separate onboarding status to track.
  // The card stays until the whole setup is done (linking Lichess no longer
  // vanishes the moment a repertoire exists), and it carries setup only:
  // due/weak training lives in the Today strip, never here.
  let lastSetupPayload = null;
  // The user can put the checklist away before finishing it (not everyone
  // wants to link Lichess); remembered per browser.
  const SETUP_DISMISSED_KEY = "prepforge.setup_dismissed";

  function setupDismissed() {
    try {
      return localStorage.getItem(SETUP_DISMISSED_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function dismissSetup() {
    try {
      localStorage.setItem(SETUP_DISMISSED_KEY, "1");
    } catch (_) {
      // storage blocked: hide for this page view only
    }
    const card = document.getElementById("dashboard-steps");
    if (card) {
      card.hidden = true;
      paint(card, "");
    }
  }

  function setupSteps(payload) {
    const repertoires = (payload && payload.repertoires) || 0;
    const accounts = Array.isArray(appState.lichessAccounts) ? appState.lichessAccounts : [];
    const linked = accounts.length > 0 || !!appState.lichessUsername;
    return [
      {
        id: "repertoire",
        title: "Build your first repertoire",
        // No button here: while this step is open the library's empty state
        // already offers New repertoire / Import PGN right beside it.
        done: repertoires > 0,
      },
      {
        id: "lichess",
        title: "Link your Lichess account",
        done: linked,
        action: "lichess",
        label: "Link Lichess",
      },
      {
        id: "train",
        // Counted from started sessions (there is no "finished" flag), so the
        // step promises only what it measures.
        title: "Start a training session",
        // A finished step reads "Done", so it can neither show a disabled Train
        // nor a reason it is locked.
        done: ((payload && payload.training_sessions) || 0) > 0,
        action: "train",
        label: "Train",
        // With no repertoire there is nothing to train, so the step says what
        // is missing instead of carrying a button that cannot apply.
        locked: repertoires === 0,
        lockNote: "Add a repertoire first",
      },
    ];
  }

  function renderSteps(payload) {
    const card = document.getElementById("dashboard-steps");
    if (!card) return;
    lastSetupPayload = payload || lastSetupPayload || {};
    const steps = setupSteps(lastSetupPayload);
    const doneCount = steps.filter((step) => step.done).length;
    if (doneCount === steps.length || setupDismissed()) {
      card.hidden = true;
      paint(card, "");
      return;
    }
    paint(
      card,
      html`<header class="card-head"><h2>Next steps</h2><span class="setup-count" data-testid="setup-progress">${doneCount} of ${steps.length} done</span><button type="button" class="btn icon setup-dismiss" data-setup-dismiss data-testid="setup-dismiss" aria-label="Hide next steps" title="Hide this checklist">&times;</button></header><div class="setup-bar" aria-hidden="true"><i style="width:${Math.round((doneCount / steps.length) * 100)}%"></i></div>${steps
        .map((step) => {
          // The mark column is a checklist: a finished step ticks, an open one
          // is an empty ring. A step number beside two ticks read as two
          // different lists, and a phone shows no number at all.
          const mark = html`<span class="step-n${step.done ? " is-done" : ""}" aria-hidden="true"></span>`;
          const cta = step.done
            ? html`<span class="step-done">Done</span>`
            : step.locked
            ? ""
            : !step.action
            ? ""
            : html`<button type="button" class="btn sm" data-lib-action="${step.action}" data-testid="setup-cta-${step.id}">${step.label}</button>`;
          const note = step.locked && !step.done ? step.lockNote : step.detail;
          return (
            html`<div class="step${step.done ? " is-done" : ""}" data-setup-step="${step.id}">${mark}<div class="step-text"><b>${step.title}</b>${note ? html`<p>${note}</p>` : ""}</div>${cta}</div>`
          );
        })}`,
    );
    card.hidden = false;
  }

  // Linking / unlinking Lichess happens outside the Library (Settings, OAuth
  // popup); re-tick the checklist from the last dashboard payload.
  function refreshSetup() {
    if (lastSetupPayload) renderSteps(lastSetupPayload);
  }

  // The listing is the live source for the repertoire count: create, import,
  // delete and set-active all refresh it, and none of them re-read
  // /api/dashboard. Same rows the Library table shows (pending deletes gone).
  function ownRepertoireCount() {
    return repListLoaded ? repListCache.own.length : null;
  }

  // Never-trained moves across the caller's active repertoires, from the
  // listing's per-repertoire health. null until the listing has loaded.
  function newMovesToLearn() {
    if (!repListLoaded) return null;
    return repListCache.own.reduce((sum, item) => {
      if (item.is_active === false || !item.health) return sum;
      return sum + (Number(item.health.untrained) || 0);
    }, 0);
  }

  // Weak moves across the caller's active repertoires. The Smart queue trains
  // them as reviews ("1 review move ready"), so the Today strip must not call
  // reviews clear while one is waiting (UX walkthrough 2026-10-01 P1-1).
  function weakMovesToReview() {
    if (!repListLoaded) return 0;
    return repListCache.own.reduce((sum, item) => {
      if (item.is_active === false || !item.health) return sum;
      return sum + (Number(item.health.weak) || 0);
    }, 0);
  }

  // Active repertoires the listing knows nothing about yet: the coverage badge
  // is written the first time a repertoire is opened or trained, so until then
  // its new and weak moves are unknown, not zero. The strip must not report a
  // clear queue while a repertoire's size is still unknown.
  function unopenedRepertoireCount() {
    if (!repListLoaded) return 0;
    return repListCache.own.filter((item) => item.is_active !== false && !item.health).length;
  }

  // Queue line for the Today strip. "Queue is clear" next to a "41 new" row
  // read as a contradiction (UX walkthrough P1-4): reviews and never-trained
  // moves are reported separately.
  function todayQueueText(due, soon, newMoves, weak = 0, unopened = 0) {
    const bits = [];
    if (due > 0) bits.push(html`<b>${due} due now</b>`);
    else if (weak > 0) bits.push(html`<b>${weak} weak spot${weak === 1 ? "" : "s"} to review</b>`);
    else if (unopened > 0) bits.push(html`<b>${unopened} repertoire${unopened === 1 ? "" : "s"} not opened yet</b>`);
    else bits.push("Reviews clear");
    if (newMoves > 0) {
      const label = `${newMoves} new move${newMoves === 1 ? "" : "s"} to learn`;
      bits.push(due > 0 || weak > 0 ? label : html`<b>${label}</b>`);
    }
    if (soon > 0) bits.push(`${soon} coming up in 24h`);
    if (bits.length === 1 && due === 0 && weak === 0 && newMoves === 0 && unopened === 0) return "Queue is clear";
    return html`${bits.map((bit, i) => html`${i ? html` &middot; ` : ""}${bit}`)}`;
  }

  let lastTodayPayload = null;

  // A failed statistics read owns the strip's slot: the message once, with the
  // retry that fixes it. Re-entering the Library (boot starts two reads) must
  // not wipe this card, so it is only replaced by success or another failure.
  function renderTodayError(message) {
    const card = document.getElementById("dashboard-today");
    if (!card) return;
    card.hidden = false;
    const written = paint(card, html`<div class="today-error" role="alert" data-testid="today-error"><span>Today is unavailable: ${message}</span><button type="button" class="btn sm" data-today-retry title="Reload today's counts">Try again</button></div>`);
    lastTodayPayload = null;
    if (written) card.querySelector("[data-today-retry]")?.addEventListener("click", () => loadDashboard().catch((e) => setStatusError(e.message)));
  }

  function renderDashboardToday(payload) {
    const card = document.getElementById("dashboard-today");
    if (!card) return;
    lastTodayPayload = payload;
    const streak = payload.streak || { current: 0, best: 0, trained_today: false };
    const due = payload.due_reviews || 0;
    const soon = payload.due_soon || 0;
    // `repertoires` on this payload is a COUNT. Hiding Today when it is 0
    // buried Train now for new accounts. Always show the strip once we have a
    // dashboard payload.
    const note = streak.trained_today
      ? `Trained today - day ${streak.current}`
      : streak.current > 0
        ? `Train today to keep your ${streak.current}-day streak`
        : "Train today to start a streak";
    let warningHtml = "";
    if (!streak.trained_today && streak.current > 0) {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const msLeft = midnight - now;
      if (msLeft < 5 * 60 * 60 * 1000) {
        const h = Math.floor(msLeft / 3600000);
        const m = Math.floor((msLeft % 3600000) / 60000);
        const left = h > 0 ? `${h}h ${m}m` : `${m}m`;
        warningHtml = html`<div class="today-warning" role="alert">${left} left to keep your ${streak.current}-day streak — one card is enough</div>`;
      }
    }
    const best = streak.best > 1 ? html`<small>best ${streak.best}</small>` : "";
    const newMoves = newMovesToLearn();
    const weak = weakMovesToReview();
    const unopened = unopenedRepertoireCount();
    // Nothing stored in the account: the primary action is the first
    // repertoire, not Train, which can only answer "no active repertoire".
    // A past training session does not change that — the account can have
    // trained before and still have no repertoire to train now.
    const firstRun = ownRepertoireCount() === 0;
    // "Queue is clear" is a claim about a queue. With no repertoire there is
    // no queue at all, so the line says what is missing instead.
    const queueText = firstRun
      ? "No repertoire to train yet"
      : todayQueueText(due, soon, newMoves, weak, unopened);
    // Nothing due but new moves waiting: the smart queue teaches them, so say so.
    const learnNew = due === 0 && weak === 0 && newMoves > 0;
    const recap = payload.recap || null;
    let recapHtml = "";
    if (recap && (recap.moves_reviewed_7d > 0 || recap.mastered_now > 0 || recap.weak_now > 0)) {
      const delta = (n, goodWhenUp) => {
        if (!n) return "";
        const cls = (n > 0) === goodWhenUp ? "up" : "down";
        return html` <span class="${cls}">(${n > 0 ? "+" : ""}${n})</span>`;
      };
      const bits = [
        `${recap.moves_reviewed_7d} move${recap.moves_reviewed_7d === 1 ? "" : "s"} reviewed · 7d`,
        html`${recap.mastered_now} mastered${delta(recap.mastered_delta, true)}`,
      ];
      if (recap.weak_now > 0 || recap.weak_delta !== 0) {
        bits.push(
          html`${recap.weak_now} weak spot${recap.weak_now === 1 ? "" : "s"}${delta(recap.weak_delta, false)}`,
        );
      }
      recapHtml = html`<div class="today-recap">${bits.map((bit, i) => html`${i ? html` &middot; ` : ""}${bit}`)}</div>`;
    }
    // The three lifetime counters are not what a user decides on before
    // pressing Train, and "Due review" already carries the queue number the
    // strip leads with — so one chip holds them and the Due shortcut stays
    // inline, where the action is.
    const metric = (value, one, many) => html`<b>${value}</b> ${nounOf(value, one, many)}`;
    const repCount = ownRepertoireCount();
    const countsHtml = [
      metric(payload.games || 0, "analysis", "analyses"),
      // Until the listing lands, fall back to the dashboard read; after it,
      // the listing is authoritative so the count tracks the table.
      metric(repCount ?? (payload.repertoires || 0), "repertoire"),
      metric(payload.training_sessions || 0, "session"),
    ].map((m, i) => html`${i ? html` &middot; ` : ""}${m}`);
    const written = paint(card, html`
    <div class="today-streak" data-lit="${streak.current > 0 ? "1" : "0"}"
         title="Calendar days with at least one graded move">
      <span class="today-count">${streak.current}</span>
      <span class="today-unit">day streak${best}</span>
    </div>
    <div class="today-body">
      <div class="today-queue">${queueText}</div>
      ${warningHtml || html`<div class="today-note">${note}</div>`}
    </div>
    <div class="today-aside">
      ${recapHtml}
      <div class="today-counts" data-testid="dashboard-counts"
           title="Saved analyses, repertoires and training sessions">${countsHtml}</div>
    </div>
    ${firstRun
      ? html`<button class="btn primary lg" data-lib-action="new" data-testid="today-primary">New repertoire</button>`
      : html`<button class="btn primary lg" id="dashboard-train-now" data-testid="dashboard-train-now">${learnNew ? "Learn new moves" : "Train"}</button>`}
  `);
    card.hidden = false;
    if (!written) return;
    if (firstRun) {
      // The strip is re-rendered on every load, so it binds its own action;
      // a Train listener looked up by id would not exist.
      card.querySelector("[data-lib-action]")?.addEventListener("click", () => createRepertoirePrompt({ title: "New repertoire" }));
      return;
    }
    const trainNow = () =>
      goToSmartTraining(
        due > 0 ? "Starting due review…" : learnNew ? "Starting new moves…" : "Starting training…",
      );
    document.getElementById("dashboard-train-now").addEventListener("click", trainNow);
  }

  // ---- Library list rendering ----------------------------------------------
  // The list renders from `repListCache` (the /api/repertoires listing: own
  // repertoires + received team shares) so the filter bar can re-render
  // client-side without another round trip. The rows themselves are painted by
  // `libraryRows`, which reconciles them against what is already on screen
  // instead of rewriting the table (see that module for why).

  const libraryRows = createLibraryRows({
    // Clicking an own row selects it, then opens its workspace; a received
    // share opens at the caller's role without claiming the local selection.
    openOwn: (repId) => {
      selectedRepId = repId;
      editRepertoire(repId);
    },
    openShared: (repId) => editRepertoire(repId),
    openRepertoireContextMenu,
    repSubline,
  });

  // An empty library (signed out, or no repertoires yet) is the prototype's
  // onboarding card: no filter chips, column header or row hint over nothing.
  // A failed load (/api/dashboard or /api/repertoires) uses the same empty
  // layout plus is-error, which also hides the search over an unknown list.
  function setLibraryEmpty(empty, { error = false } = {}) {
    const card = document.querySelector("#view-dashboard .lib-list");
    if (card) {
      card.classList.toggle("is-loading", false);
      card.classList.toggle("is-empty", empty || error);
      card.classList.toggle("is-error", error);
    }
    if (onLibraryStateChange) onLibraryStateChange();
  }

  // First listing failure offers a scoped Retry; refresh keeps usable rows.
  function renderLibraryListError(message) {
    const container = document.getElementById("dashboard-repertoires");
    if (!container) return;
    repListCache = { own: [], shared: [] };
    repListLoaded = false;
    countBadge(null);
    setListboxRole(container, false);
    setLibraryEmpty(true, { error: true });
    paint(container, html`
      <div class="empty-state is-error" role="alert" data-testid="library-list-error">
        <h3>Could not refresh your repertoires.</h3>
        <p>${String(message || "The server did not respond.")}</p>
        <div class="row gap">
          <button type="button" class="btn primary" data-lib-action="retry-list">Try again</button>
        </div>
      </div>`);
    selectedRepId = null;
  }

  function renderRepertoireList() {
    const container = document.getElementById("dashboard-repertoires");
    if (!container) return;
    const focused = document.activeElement;
    const focusedRow = focused?.closest?.(".lib-row");
    const focusedId = focusedRow && container.contains(focusedRow) ? focusedRow.dataset.repertoireId : null;
    const focusedMenu = focusedId && focused.matches(".row-menu-btn");
    const universe = [...repListCache.own, ...repListCache.shared];
    setLibraryEmpty(!universe.length);
    const shown = filterLibraryRows(universe, {
      filter: libraryFilter,
      query: libraryQuery,
    });
    if (!universe.length) {
      setListboxRole(container, false);
      paint(container, html`
        <div class="empty-state big">
          <h3>No repertoires yet.</h3>
          <p>Create a repertoire, import a PGN, or build one from a game.</p>
          <div class="row gap">
            <button type="button" class="btn primary" data-lib-action="new">New repertoire</button>
            <button type="button" class="btn" data-lib-action="import">Import PGN</button>
          </div>
        </div>`);
      selectedRepId = null;
      return;
    }
    if (!shown.length) {
      // Non-empty list narrowed to nothing by the filter/search. On phones the
      // filter chips are hidden in this state, so the card carries the way back.
      const q = libraryQuery.trim();
      setListboxRole(container, false);
      paint(container, html`<div class="empty-state lib-no-match" data-testid="library-no-match">
        <p>No repertoires match ${q ? "this search" : "this filter"}.</p>
        <button type="button" class="btn sm" data-lib-action="clear-filter">Clear filter</button>
      </div>`);
      selectedRepId = null;
      return;
    }
    setListboxRole(container, true);
    // Selection follows the visible list: narrowing the table moves the
    // selection to the first shown row when the old one is filtered out — the
    // same rule the unfiltered table has for a row that disappears.
    const shownOwn = shown.filter((item) => !item.sharedRow);
    // The repertoire open in Build is the selected row: one created or opened
    // elsewhere (Build's New repertoire, the palette, a link) is the one to mark.
    const openId = appState.build?.repertoire_id ? String(appState.build.repertoire_id) : null;
    if (openId && shownOwn.some((item) => String(item.id) === openId)) selectedRepId = openId;
    if (!selectedRepId || !shownOwn.some((item) => String(item.id) === selectedRepId)) {
      selectedRepId = shownOwn.length ? String(shownOwn[0].id) : null;
    }
    // A filter or search keeps the rows it still shows: they are already
    // settled on screen, so narrowing the table does not replay the entrance.
    const painted = libraryRows.render(
      container,
      shown.filter((item) => !item.sharedRow),
      shown.filter((item) => item.sharedRow),
      { selectedRepId, staggerRows },
    );
    // The row painter owns the nodes, so the note paint() keeps for the empty
    // states in this same container no longer describes what is there.
    forget(container);
    // Focus follows the repertoire, not its node: a kept row usually keeps its
    // focus for free, and one that was rebuilt (the row changed) or moved (the
    // server reordered the list) is put back on the same repertoire. Search,
    // menus and other views keep whatever they had.
    if (focusedId) {
      const row = [...painted].find((el) => el.dataset.repertoireId === focusedId);
      const target = focusedMenu ? row?.querySelector(".row-menu-btn") : row;
      if (target && globalThis.document.activeElement !== target) target.focus({ preventScroll: true });
    }
  }

  // role=option rows need a real listbox owner; empty states drop the role.
  function setListboxRole(container, on) {
    const cols = document.getElementById("lib-cols");
    if (cols) cols.hidden = !on;
    if (on) {
      container.setAttribute("role", "listbox");
      container.setAttribute("aria-label", "Repertoires");
    } else {
      container.removeAttribute("role");
      container.removeAttribute("aria-label");
    }
  }

  function updateLibraryFilterChips() {
    document.querySelectorAll("[data-lib-filter]").forEach((btn) => {
      const on = (btn.dataset.libFilter || "all") === libraryFilter;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }

  function setLibraryFilter(filter) {
    libraryFilter = filter || "all";
    updateLibraryFilterChips();
    renderRepertoireList();
  }

  function setLibraryQuery(query) {
    libraryQuery = String(query ?? "");
    renderRepertoireList();
  }

  // The query lives in the input element, so clearing it clears both.
  function clearLibraryFilter() {
    libraryQuery = "";
    const search = document.getElementById("lib-filter-search");
    if (search) search.value = "";
    setLibraryFilter("all");
  }

  // Fetches and renders the listing; throws on failure so each caller picks
  // its own error composition.
  async function fetchDashboardRepertoires(seq, isCurrent = currentLoad(seq)) {
    // Team names are optional and never block usable repertoire rows.
    if (appState.signedIn) {
      void loadTeamDirectory(appState, api).then((teams) => {
        if (teams !== null && isCurrent() && repListLoaded) renderRepertoireList();
      }).catch(() => {});
    }
    const payload = await api("/api/repertoires");
    if (!isCurrent()) return false;
    const status = document.getElementById("library-refresh-status");
    if (status) status.hidden = true;
    appState.repertoireList = payload.repertoires || [];
    appState.sharedRepertoireList = payload.shared || [];
    const visible = (payload.repertoires || []).filter(
      (item) => !appState.pendingRepDeletes.has(String(item.id)),
    );
    const sharedRows = (Array.isArray(payload.shared) ? payload.shared : []).map(
      (item) => ({ ...item, sharedRow: true }),
    );
    // The count badge counts the full listing — never the filtered view.
    countBadge(visible.length + sharedRows.length);
    repListCache = { own: visible, shared: sharedRows };
    repListLoaded = true;
    renderRepertoireList();
    // Every create / import / delete ends in this refresh: keep Get started
    // in step with it instead of the last /api/dashboard read.
    if (lastSetupPayload) renderSteps({ ...lastSetupPayload, repertoires: visible.length });
    // The Today strip's "new moves to learn" depends on this listing.
    const today = document.getElementById("dashboard-today");
    if (lastTodayPayload && today && !today.hidden) renderDashboardToday(lastTodayPayload);
    // A first-run strip (no dashboard read yet) still learns it has none.
    else refreshFirstRunAction();
    return true;
  }

  // Background refresh (after CRUD elsewhere): a failure only replaces the
  // list with a scoped error card — Today / Get started stay as they were —
  // and is reported through setStatusError. Resolves to false on failure.
  async function loadDashboardRepertoires() {
    const seq = ++loadSeq;
    const isCurrent = currentLoad(seq);
    try {
      return await fetchDashboardRepertoires(seq, isCurrent);
    } catch (error) {
      if (!isCurrent()) return false;
      reportListFailure(error.message);
      return false;
    }
  }

  // Signed-out Library: the same empty-library composition as a first-run
  // account, with sign-in as the primary action. No owner-scoped API calls.
  function renderSignedOut() {
    loadSeq += 1;
    const container = document.getElementById("dashboard-repertoires");
    if (!container) return;
    repListCache = { own: [], shared: [] };
    repListLoaded = false;
    countBadge(null);
    setListboxRole(container, false);
    setLibraryEmpty(true);
    paint(container, html`
      <div class="empty-state big" data-testid="library-signed-out">
        <h3>Sign in to start your library.</h3>
        <p>Sign in, then create a repertoire or import a PGN.</p>
        <div class="row gap">
          <button type="button" class="btn primary" data-lib-action="signin">Sign in</button>
          <button type="button" class="btn" data-lib-action="import">Import PGN</button>
        </div>
      </div>`);
    selectedRepId = null;
    lastTodayPayload = null;
    const today = document.getElementById("dashboard-today");
    if (today) today.hidden = true;
    // The empty state above already carries the one Sign in action.
    renderOnboardingSteps([
      ["Create your first repertoire", "Pick a side and an opening — or turn one of your games into one.", "new", "New repertoire"],
      [
        "Analyze a game",
        "Paste a PGN or import a game.",
        "analyze",
        "Open Analyze",
      ],
    ]);
  }

  // A listing refresh can land before the first dashboard read; a first-run
  // strip only follows the count once it is known.
  function refreshFirstRunAction() {
    const card = document.getElementById("dashboard-today");
    if (!card || card.hidden) return;
    const train = card.querySelector('[data-testid="dashboard-train-now"]');
    if (!train || !ownRepertoireCount()) return;
    if (lastTodayPayload) renderDashboardToday(lastTodayPayload);
  }

  // "Get started" checklist; buttons are delegated through data-lib-action.
  function renderOnboardingSteps(steps) {
    const card = document.getElementById("dashboard-steps");
    if (!card) return;
    paint(
      card,
      html`<header class="card-head"><h2>Next steps</h2></header>${steps
        .map(
          ([title, detail, action, label]) =>
            html`<div class="step"><span class="step-n" aria-hidden="true"></span><div class="step-text"><b>${title}</b>${detail ? html`<p>${detail}</p>` : ""}</div><button type="button" class="btn sm" data-lib-action="${action}">${label}</button></div>`,
        )}`,
    );
    card.hidden = false;
  }

  // Either endpoint failing leaves the error card and rethrows, so the caller
  // reports it via setStatusError — "Ready" is only set on a full success.
  async function loadDashboard() {
    const seq = ++loadSeq;
    const isCurrent = currentLoad(seq);
    const statistics = (async () => {
      try {
        const payload = await api(`/api/dashboard?local_date=${localDateString()}`);
        if (!isCurrent()) return;
        if (payload.streak) appState.dayStreak = payload.streak;
        renderDashboardToday(payload);
        renderSteps(payload);
      } catch (error) {
        if (!isCurrent()) return;
        // The strip shows the failure and its retry; the caller adds the status
        // line for the view, so the message is named in both places at most once
        // each (the old raw markup rendered it twice in the strip itself).
        renderTodayError(error.message);
        throw error;
      }
    })();
    const listing = fetchDashboardRepertoires(seq, isCurrent).catch((error) => {
      if (isCurrent()) reportListFailure(error.message);
      throw error;
    });
    const results = await Promise.allSettled([statistics, listing]);
    if (!isCurrent()) return;
    const failure = results.find((result) => result.status === "rejected");
    if (failure) throw failure.reason;
    setStatus("Ready");
  }

  async function dashboardImportPgn() {
    if (!requireSignIn("Sign in to import a repertoire", "import-pgn")) return;
    const input = document.getElementById("dashboard-import-input");
    input.value = "";
    input.click();
  }

  async function handleImportPgnFile(file) {
    if (!requireSignIn("Sign in to import a repertoire", "import-pgn")) return;
    if (!file) return;
    let text;
    try {
      text = await file.text();
    } catch (_) {
      setStatus("Could not read file");
      return;
    }
    // Route by EXTENSION only: a .pgn whose text begins with a brace comment ({…})
    // must stay a PGN import, and a .json that isn't a valid PrepForge package must
    // fail with a clear package-import error instead of a JSON parse detail.
    if (isPackageJsonFilename(file.name)) {
      try {
        let pkg;
        try {
          pkg = JSON.parse(text);
        } catch (_) {
          throw new Error(MALFORMED_JSON_IMPORT_ERROR);
        }
        if (!pkg || typeof pkg !== "object" || Array.isArray(pkg)) {
          throw new Error(MALFORMED_JSON_IMPORT_ERROR);
        }
        const payload = await postJson("/api/repertoires/import", { package_json: text });
        await hydrateBuild(payload, payload.selected_node_id);
        appState.trainingRepertoireId = payload.repertoire_id;
        await loadDashboardRepertoires();
        setStatus(`Imported ${payload.name}`);
      } catch (error) {
        setStatus(error.message);
      }
      return;
    }
    try {
      await promptImportRepertoireFromPgn(text, {
        defaultName: file.name.replace(/\.[^.]+$/, ""),
      });
    } catch (_) {
      /* status already set */
    }
  }

  function bind() {
    if (eventsBound) return;
    eventsBound = true;

    const newRep = () => createRepertoirePrompt({ title: "New repertoire" });
    const importPgn = () => dashboardImportPgn().catch(() => {});
    const libAction = (action) => {
      if (action === "new") newRep();
      else if (action === "import") importPgn();
      else if (action === "signin") {
        if (openSignIn) openSignIn();
        else requireSignIn("Sign in (or create an account) to start your library");
      } else if (action === "clear-filter") {
        clearLibraryFilter();
      } else if (action === "retry") {
        loadDashboard().catch((error) => setStatusError(error.message));
      } else if (action === "retry-list") {
        loadDashboardRepertoires().then((ok) => {
          if (ok) setStatus("Ready");
        });
      } else if (action === "analyze" && goToView) goToView("analyze");
      else if (action === "train" && goToSmartTraining) goToSmartTraining("Starting training…");
      else if (action === "lichess") {
        // Linking lives in Settings → Account (Chess accounts); the app opens Settings via
        // its tab and jumps to the section once the view has rendered.
        if (openSettingsSection) openSettingsSection("set-connections").catch(() => {});
        else if (goToView) goToView("settings");
      }
    };
    const newRepBtn = document.getElementById("dashboard-new-rep");
    if (newRepBtn) newRepBtn.addEventListener("click", newRep);
    const importBtn = document.getElementById("dashboard-import-pgn");
    if (importBtn) importBtn.addEventListener("click", importPgn);
    // The empty state repeats the two header actions (re-rendered with the
    // list, so delegated from the stable container).
    const listEl = document.getElementById("dashboard-repertoires");
    if (listEl) {
      listEl.addEventListener("click", (event) => {
        const btn = event.target.closest && event.target.closest("[data-lib-action]");
        if (btn) libAction(btn.dataset.libAction);
      });
    }
    // The signed-out Get started card carries the same delegated actions.
    const stepsEl = document.getElementById("dashboard-steps");
    if (stepsEl) {
      stepsEl.addEventListener("click", (event) => {
        if (event.target.closest && event.target.closest("[data-setup-dismiss]")) {
          dismissSetup();
          return;
        }
        const btn = event.target.closest && event.target.closest("[data-lib-action]");
        if (btn) libAction(btn.dataset.libAction);
      });
    }

    const importInput = document.getElementById("dashboard-import-input");
    if (importInput) {
      importInput.addEventListener("change", (event) => {
        handleImportPgnFile(event.target.files && event.target.files[0]).catch(() => {});
      });
    }

    // Library filter bar (segmented filters + repertoire search) — client-side.
    document.querySelectorAll("[data-lib-filter]").forEach((btn) => {
      btn.addEventListener("click", () => setLibraryFilter(btn.dataset.libFilter));
    });
    const libSearch = document.getElementById("lib-filter-search");
    if (libSearch) {
      libSearch.addEventListener("input", () => setLibraryQuery(libSearch.value));
    }

    const dashCard = document.getElementById("dashboard-repertoires");
    bindDropZone(dashCard && dashCard.closest(".card"), (file) => {
      handleImportPgnFile(file).catch(() => {});
    });
  }

  return {
    bind,
    loadDashboard,
    loadDashboardRepertoires,
    renderDashboardToday,
    renderSignedOut,
    refreshSetup,
    setLibraryFilter,
    setLibraryQuery,
  };
}
