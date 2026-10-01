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
// color, visibility, is_active); shared read-only fallback rows carry
// `sharedRow`. Filtering never refetches or reshapes a row.
export function filterLibraryRows(rows, { filter = "all", query = "" } = {}) {
  const q = query.trim().toLowerCase();
  return (rows || []).filter((item) => {
    if (q && !String(item.name || "").toLowerCase().includes(q)) return false;
    if (filter === "all") return true;
    if (filter === "shared") return item.sharedRow === true || item.visibility === "team";
    if (filter === "disabled") return item.is_active === false;
    return String(item.color || "") === filter;
  });
}

export function createDashboardView({
  appState,
  api,
  postJson,
  escapeHtml,
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
  // Full loads and mutation refreshes share ownership of the same list/cache.
  let loadSeq = 0;

  // "Black · 142 moves to train" (+ disabled / shared-with in the preview) —
  // only real listing fields (colour, health.trainable, visibility/team). The
  // listing has no line count or last-trained date, so neither is shown.
  function repSubline(item, { detail = false } = {}) {
    const bits = [String(item.color || "") === "black" ? "Black" : "White"];
    if (item.health && item.health.trainable) {
      // Same wording as the Repertoire header's "· N to train".
      bits.push(`${item.health.trainable} move${item.health.trainable === 1 ? "" : "s"} to train`);
    }
    if (!detail) return bits.join(" · ");
    if (item.is_active === false) bits.push("disabled");
    if (item.visibility === "team" && item.team_id) {
      const team = (appState.teams || []).find((tm) => tm.id === item.team_id);
      bits.push(`shared with ${team ? team.name : "team"}`);
    }
    return bits.join(" · ");
  }

  function applySelectionHighlight() {
    const container = document.getElementById("dashboard-repertoires");
    if (!container) return;
    container.querySelectorAll("[data-repertoire-id]").forEach((row) => {
      const selected = row.dataset.repertoireId === selectedRepId;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", String(selected));
      // The role=option lives on the inner .lib-opt (it must not own the menu
      // button), so its aria-selected mirrors the row's selection state.
      row.querySelectorAll(".lib-opt").forEach((opt) => {
        opt.setAttribute("aria-selected", String(selected));
      });
    });
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
      card.innerHTML = "";
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
        detail: "New repertoire or Import PGN, in your library.",
        done: repertoires > 0,
      },
      {
        id: "lichess",
        title: "Link your Lichess account",
        detail: "Games and Scout read every linked identity as Self.",
        done: linked,
        action: "lichess",
        label: "Link Lichess",
      },
      {
        id: "train",
        title: "Finish a training session",
        detail: repertoires > 0
          ? "The smart queue schedules your reviews from there."
          : "Unlocks once you have a repertoire.",
        done: ((payload && payload.training_sessions) || 0) > 0,
        action: "train",
        label: "Train",
        locked: repertoires === 0,
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
      card.innerHTML = "";
      return;
    }
    card.innerHTML =
      `<header class="card-head"><h2>Get started</h2>` +
      `<span class="setup-count" data-testid="setup-progress">${doneCount} of ${steps.length} done</span>` +
      `<button type="button" class="ib setup-dismiss" data-setup-dismiss data-testid="setup-dismiss" ` +
      `aria-label="Hide Get started" title="Hide this checklist">&times;</button></header>` +
      `<div class="setup-bar" aria-hidden="true"><i style="width:${Math.round((doneCount / steps.length) * 100)}%"></i></div>` +
      steps
        .map((step, i) => {
          const mark = step.done
            ? `<span class="step-n is-done" aria-hidden="true">✓</span>`
            : `<span class="step-n" aria-hidden="true">${i + 1}</span>`;
          const cta = step.done
            ? `<span class="step-done">Done</span>`
            : !step.action
            ? ""
            : `<button type="button" class="btn sm" data-lib-action="${step.action}"` +
              `${step.locked ? " disabled" : ""} data-testid="setup-cta-${step.id}">${escapeHtml(step.label)}</button>`;
          return (
            `<div class="step${step.done ? " is-done" : ""}" data-setup-step="${step.id}">${mark}` +
            `<div class="step-text"><b>${escapeHtml(step.title)}</b><p>${escapeHtml(step.detail)}</p></div>${cta}</div>`
          );
        })
        .join("");
    card.hidden = false;
  }

  // Linking / unlinking Lichess happens outside the Library (Settings, OAuth
  // popup); re-tick the checklist from the last dashboard payload.
  function refreshSetup() {
    if (lastSetupPayload) renderSteps(lastSetupPayload);
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

  // Queue line for the Today strip. "Queue is clear" next to a "41 new" row
  // read as a contradiction (UX walkthrough P1-4): reviews and never-trained
  // moves are reported separately.
  function todayQueueText(due, soon, newMoves, weak = 0) {
    const bits = [];
    if (due > 0) bits.push(`<b>${due} due now</b>`);
    else if (weak > 0) bits.push(`<b>${weak} weak spot${weak === 1 ? "" : "s"} to review</b>`);
    else bits.push("Reviews clear");
    if (newMoves > 0) {
      const label = `${newMoves} new move${newMoves === 1 ? "" : "s"} to learn`;
      bits.push(due > 0 || weak > 0 ? label : `<b>${label}</b>`);
    }
    if (soon > 0) bits.push(`${soon} coming up in 24h`);
    if (bits.length === 1 && due === 0 && weak === 0 && newMoves === 0) return "Queue is clear";
    return bits.join(" &middot; ");
  }

  let lastTodayPayload = null;

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
      ? `Trained today - day ${streak.current} ✓`
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
        warningHtml = `<div class="today-warning" role="alert">⏰ ${left} left to keep your ${streak.current}-day streak — one card is enough</div>`;
      }
    }
    const best = streak.best > 1 ? `<small>best ${streak.best}</small>` : "";
    const newMoves = newMovesToLearn();
    const weak = weakMovesToReview();
    const queueText = todayQueueText(due, soon, newMoves, weak);
    // Nothing due but new moves waiting: the smart queue teaches them, so say so.
    const learnNew = due === 0 && weak === 0 && newMoves > 0;
    const recap = payload.recap || null;
    let recapHtml = "";
    if (recap && (recap.reviews_7d > 0 || recap.mastered_now > 0 || recap.weak_now > 0)) {
      const delta = (n, goodWhenUp) => {
        if (!n) return "";
        const cls = (n > 0) === goodWhenUp ? "up" : "down";
        return ` <span class="${cls}">(${n > 0 ? "+" : ""}${n})</span>`;
      };
      const bits = [
        `${recap.reviews_7d} review${recap.reviews_7d === 1 ? "" : "s"} this week`,
        `${recap.mastered_now} mastered${delta(recap.mastered_delta, true)}`,
      ];
      if (recap.weak_now > 0 || recap.weak_delta !== 0) {
        bits.push(
          `${recap.weak_now} weak spot${recap.weak_now === 1 ? "" : "s"}${delta(recap.weak_delta, false)}`,
        );
      }
      recapHtml = `<div class="today-recap">${bits.join(" &middot; ")}</div>`;
    }
    // Counters from the real dashboard payload; "Due review" is a shortcut into
    // the smart queue when something is waiting (same action as Train).
    const metric = (label, value, dueShortcut) =>
      dueShortcut
        ? `<button type="button" class="metric is-due" data-action="due-review"><b>${value}</b><span>${label}</span></button>`
        : `<div class="metric"><b>${value}</b><span>${label}</span></div>`;
    const metricsHtml = [
      metric("Games", payload.games || 0, false),
      metric("Repertoires", payload.repertoires || 0, false),
      metric("Sessions", payload.training_sessions || 0, false),
      metric("Due review", due, due > 0),
    ].join("");
    card.innerHTML = `
    <div class="today-streak" data-lit="${streak.current > 0 ? "1" : "0"}"
         title="Calendar days with at least one graded move">
      <span class="today-flame" aria-hidden="true">\u{1F525}</span>
      <span class="today-count">${streak.current}</span>
      <span class="today-unit">day streak${best}</span>
    </div>
    <div class="today-body">
      ${warningHtml || `<div class="today-note">${note}</div>`}
      <div class="today-queue">${queueText}</div>
      ${recapHtml}
    </div>
    <div class="today-metrics">${metricsHtml}</div>
    <button class="btn primary lg" id="dashboard-train-now" data-testid="dashboard-train-now">${learnNew ? "Learn new moves" : "Train"}</button>
  `;
    card.hidden = false;
    const trainNow = () =>
      goToSmartTraining(
        due > 0 ? "Starting due review…" : learnNew ? "Starting new moves…" : "Starting training…",
      );
    document.getElementById("dashboard-train-now").addEventListener("click", trainNow);
    const dueMetric = card.querySelector('[data-action="due-review"]');
    if (dueMetric) dueMetric.addEventListener("click", trainNow);
  }

  // ---- Library list rendering ----------------------------------------------
  // The list renders from `repListCache` (the /api/repertoires listing: own
  // repertoires + team shares) so the filter bar can re-render client-side
  // without another round trip. Own rows normally; the shared read-only list
  // when the account has no own repertoires (fallback preserved).

  function renderSharedFallbackRows(container, rows) {
    // No own repertoires but team shares exist: surface them read-only so
    // the Library still offers something to open.
    container.innerHTML = rows
      .map(
        (item) => `
          <div class="lib-row is-shared" tabindex="0" data-repertoire-id="${escapeHtml(item.id)}" data-shared="1">
            <span class="lib-opt" role="option" aria-selected="false">
              <span class="lib-cell-rep">
                <span class="color-dot ${escapeHtml(item.color)}"></span>
                <span class="lib-name">
                  <span class="lib-name-line"><b class="name">${escapeHtml(item.name)}</b><span class="lib-chip is-shared">shared</span></span>
                  <small class="rep-sub">${String(item.color) === "black" ? "Black" : "White"} · read-only</small>
                </span>
              </span>
              <span class="lib-cell-mastery"><span class="muted">read-only</span></span>
              <span class="lib-cell-queue"><span class="muted">—</span></span>
            </span>
          </div>`,
      )
      .join("");
    container.querySelectorAll(".lib-row").forEach((row) => {
      const open = () => editRepertoire(row.dataset.repertoireId);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
    });
  }

  // ARIA listbox/option structure: the option role must not contain interactive
  // widgets (the per-row ⋯ menu button). So the listbox owner is the row itself
  // and the menu button sits as a SIBLING of the option, inside the grid row:
  // <div class=lib-row (row wrapper, not an option)>
  //   <span role=option aria-selected …>cells</span>
  //   <button ⋯>
  // The role=option lands on the .lib-opt span covering the info cells; the
  // row's click/keyboard handlers stay on the wrapper so interaction is
  // unchanged, and the button is no longer inside an option.
  function renderOwnRepertoireRows(container, visible) {
    // Library table (prototype layout): one row per repertoire with name,
    // an inline mastery bar from the cached health badge, and the queue
    // chips. The listing API carries no line count or last-trained date, so
    // the prototype's "Lines" / "Last trained" columns stay out rather than
    // inventing data.
    if (!selectedRepId || !visible.some((item) => String(item.id) === selectedRepId)) {
      selectedRepId = String(visible[0].id);
    }
    container.innerHTML = visible
      .map((item) => {
        const id = escapeHtml(item.id);
        const name = escapeHtml(item.name);
        const color = escapeHtml(item.color);
        const active = item.is_active !== false;
        const cls = [
          "lib-row",
          active ? "" : "is-disabled",
          String(item.id) === selectedRepId ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const chipsHtml =
          (active ? "" : '<span class="lib-chip">disabled</span>') +
          (item.visibility === "team" && item.team_id
            ? `<span class="lib-chip is-shared" title="Shared with ${escapeHtml(
                (appState.teams.find((tm) => tm.id === item.team_id) || {}).name || "team",
              )}">shared</span>`
            : "");
        const health = item.health;
        const pct = health ? health.mastery_pct || 0 : null;
        const tier = pct == null ? "" : pct >= 80 ? "high" : pct >= 40 ? "mid" : "low";
        const mastery = pct == null
          ? '<span class="lib-mastery lib-mastery-none">no moves trained yet</span>'
          : `<span class="lib-mastery"><span class="lib-mbar" role="img" aria-label="${pct}% mastered"><i class="tier-${tier}" style="width:${pct}%"></i></span><b>${pct}%</b></span>`;
        const queue = [];
        if (health && health.weak) {
          queue.push(`<span class="kchip k-weak" title="Missed more than answered">${health.weak} weak</span>`);
        }
        if (health && health.due) {
          queue.push(`<span class="kchip k-due" title="Spaced repetition says now">${health.due} due</span>`);
        }
        if (health && health.untrained) {
          queue.push(`<span class="kchip k-new" title="Never trained">${health.untrained} new</span>`);
        }
        const queueHtml = queue.length ? queue.join("") : '<span class="muted">—</span>';
        return `
          <div class="${cls}" tabindex="0" data-repertoire-id="${id}" data-active="${active ? "1" : "0"}" aria-selected="${String(item.id) === selectedRepId}">
            <span class="lib-opt" role="option" aria-selected="${String(item.id) === selectedRepId}">
              <span class="lib-cell-rep">
                <span class="color-dot ${color}"></span>
                <span class="lib-name">
                  <span class="lib-name-line"><b class="name">${name}</b>${chipsHtml}</span>
                  <small class="rep-sub">${escapeHtml(repSubline(item))}</small>
                </span>
              </span>
              <span class="lib-cell-mastery">${mastery}</span>
              <span class="lib-cell-queue">${queueHtml}</span>
            </span>
            <button type="button" class="row-menu-btn" data-row-menu="${id}" title="Actions (train · rename · share · delete)" aria-label="Actions for ${name}" aria-haspopup="menu">⋯</button>
          </div>
        `;
      })
      .join("");
    applySelectionHighlight();
    container.querySelectorAll(".lib-row").forEach((row) => {
      const repId = row.dataset.repertoireId;
      const open = () => {
        selectedRepId = repId;
        editRepertoire(repId);
      };
      row.addEventListener("click", (event) => {
        if (event.target.closest(".row-menu-btn")) return;
        open();
      });
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          // Enter / Space open the workspace, the same as a click.
          open();
        }
      });
      row.addEventListener("contextmenu", (event) =>
        openRepertoireContextMenu(event, repId, row.dataset.active === "1"),
      );
    });
    container.querySelectorAll(".row-menu-btn").forEach((btn) => {
      btn.addEventListener("click", (event) => {
        event.stopPropagation();
        const row = btn.closest(".lib-row");
        const rect = btn.getBoundingClientRect();
        openRepertoireContextMenu(
          { preventDefault: () => {}, clientX: rect.left, clientY: rect.bottom + 4 },
          row.dataset.repertoireId,
          row.dataset.active === "1",
        );
      });
    });
  }

  // An empty library (signed out, or no repertoires yet) is the prototype's
  // onboarding card: no filter chips, column header or row hint over nothing.
  // A failed load (/api/dashboard or /api/repertoires) uses the same empty
  // layout plus is-error, which also hides the search over an unknown list.
  function setLibraryEmpty(empty, { error = false } = {}) {
    const card = document.querySelector("#view-dashboard .lib-list");
    if (card) {
      card.classList.toggle("is-empty", empty || error);
      card.classList.toggle("is-error", error);
    }
    if (onLibraryStateChange) onLibraryStateChange();
  }

  // One error card for either failing endpoint: no stale rows, no filter
  // chips / columns / hint, no preview, and a Retry that reruns the full load.
  function renderLibraryError(message) {
    const container = document.getElementById("dashboard-repertoires");
    if (!container) return;
    repListCache = { own: [], shared: [] };
    repListLoaded = false;
    countBadge(null);
    setListboxRole(container, false);
    setLibraryEmpty(true, { error: true });
    container.innerHTML = `
      <div class="empty-state big is-error" role="alert" data-testid="library-error">
        <div class="es-mark" aria-hidden="true">!</div>
        <h3>Could not load your library.</h3>
        <p>${escapeHtml(String(message || "The server did not respond."))}</p>
        <div class="row gap">
          <button type="button" class="btn primary" data-lib-action="retry">Try again</button>
        </div>
      </div>`;
    selectedRepId = null;
    const today = document.getElementById("dashboard-today");
    if (today) today.hidden = true;
    const steps = document.getElementById("dashboard-steps");
    if (steps) {
      steps.hidden = true;
      steps.innerHTML = "";
    }
  }

  // Background-refresh failure: the error is scoped to the list card. The
  // page composition (Today strip, Get started steps) is left untouched and
  // Retry reloads only the listing.
  function renderLibraryListError(message) {
    const container = document.getElementById("dashboard-repertoires");
    if (!container) return;
    repListCache = { own: [], shared: [] };
    repListLoaded = false;
    countBadge(null);
    setListboxRole(container, false);
    setLibraryEmpty(true, { error: true });
    container.innerHTML = `
      <div class="empty-state is-error" role="alert" data-testid="library-list-error">
        <div class="es-mark" aria-hidden="true">!</div>
        <h3>Could not refresh your repertoires.</h3>
        <p>${escapeHtml(String(message || "The server did not respond."))}</p>
        <div class="row gap">
          <button type="button" class="btn primary" data-lib-action="retry-list">Try again</button>
        </div>
      </div>`;
    selectedRepId = null;
  }

  function renderRepertoireList() {
    const container = document.getElementById("dashboard-repertoires");
    if (!container) return;
    const focused = document.activeElement;
    const focusedRow = focused?.closest?.(".lib-row");
    const focusedId = focusedRow && container.contains(focusedRow) ? focusedRow.dataset.repertoireId : null;
    const focusedMenu = focusedId && focused.matches(".row-menu-btn");
    const useSharedFallback =
      !repListCache.own.length && repListCache.shared.length > 0;
    const universe = useSharedFallback ? repListCache.shared : repListCache.own;
    setLibraryEmpty(!universe.length);
    // Selection follows the visible list: narrowing the table moves the
    // selection to the first shown row when the old one is filtered out — the
    // same rule the unfiltered table always had for a disappearing row.
    const shown = filterLibraryRows(universe, {
      filter: libraryFilter,
      query: libraryQuery,
    });
    if (!universe.length) {
      setListboxRole(container, false);
      container.innerHTML = `
        <div class="empty-state big">
          <div class="es-mark" aria-hidden="true">♜</div>
          <h3>No repertoires yet.</h3>
          <p>A repertoire is your prepared tree of moves. Start from scratch, import a PGN, or build one from a game you just played.</p>
          <div class="row gap">
            <button type="button" class="btn primary" data-lib-action="new">New repertoire</button>
            <button type="button" class="btn" data-lib-action="import">Import PGN</button>
          </div>
        </div>`;
      selectedRepId = null;
      return;
    }
    if (!shown.length) {
      // Non-empty list narrowed to nothing by the filter/search.
      setListboxRole(container, false);
      container.innerHTML =
        '<div class="empty-state">No repertoires match this filter.</div>';
      selectedRepId = null;
      return;
    }
    setListboxRole(container, true);
    if (useSharedFallback) {
      renderSharedFallbackRows(container, shown);
    } else {
      renderOwnRepertoireRows(container, shown);
    }
    // Refresh replaces the row elements. Keep keyboard navigation on the same
    // repertoire, without stealing focus from search, menus or another view.
    if (focusedId) {
      const row = [...container.querySelectorAll(".lib-row")].find((el) => el.dataset.repertoireId === focusedId);
      (focusedMenu ? row?.querySelector(".row-menu-btn") : row)?.focus({ preventScroll: true });
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

  // Fetches and renders the listing; throws on failure so each caller picks
  // its own error composition.
  async function fetchDashboardRepertoires(seq) {
    if (appState.signedIn && !appState.teams.length) {
      try {
        const teamsPayload = await api("/api/teams");
        if (seq !== loadSeq) return false;
        appState.teams = teamsPayload.teams || [];
      } catch (_) {
        /* team names for share badges are optional */
      }
    }
    if (seq !== loadSeq) return false;
    const payload = await api("/api/repertoires");
    if (seq !== loadSeq) return false;
    appState.repertoireList = payload.repertoires || [];
    const visible = (payload.repertoires || []).filter(
      (item) => !appState.pendingRepDeletes.has(String(item.id)),
    );
    const sharedRows = (Array.isArray(payload.shared) ? payload.shared : []).map(
      (item) => ({ ...item, sharedRow: true }),
    );
    // The count badge counts the full listing — never the filtered view.
    if (!visible.length && sharedRows.length) {
      countBadge(sharedRows.length);
    } else {
      countBadge(visible.length);
    }
    repListCache = { own: visible, shared: sharedRows };
    repListLoaded = true;
    renderRepertoireList();
    // The Today strip's "new moves to learn" depends on this listing.
    const today = document.getElementById("dashboard-today");
    if (lastTodayPayload && today && !today.hidden) renderDashboardToday(lastTodayPayload);
    return true;
  }

  // Background refresh (after CRUD elsewhere): a failure only replaces the
  // list with a scoped error card — Today / Get started stay as they were —
  // and is reported through setStatusError. Resolves to false on failure.
  async function loadDashboardRepertoires() {
    const seq = ++loadSeq;
    try {
      return await fetchDashboardRepertoires(seq);
    } catch (error) {
      if (seq !== loadSeq) return false;
      renderLibraryListError(error.message);
      setStatusError(error.message);
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
    container.innerHTML = `
      <div class="empty-state big" data-testid="library-signed-out">
        <div class="es-mark" aria-hidden="true">♜</div>
        <h3>Sign in to start your library.</h3>
        <p>Repertoires, the training queue and game reviews are saved to your account. You can explore the board in Analyze without one.</p>
        <div class="row gap">
          <button type="button" class="btn primary" data-lib-action="signin">Sign in</button>
          <button type="button" class="btn" data-lib-action="import">Import PGN</button>
        </div>
      </div>`;
    selectedRepId = null;
    lastTodayPayload = null;
    const today = document.getElementById("dashboard-today");
    if (today) today.hidden = true;
    renderOnboardingSteps([
      ["Sign in or create an account", "Your library, streak and queue follow you across devices.", "signin", "Sign in"],
      ["Create your first repertoire", "Pick a side and an opening — or turn one of your games into one.", "new", "New repertoire"],
      [
        "Analyze a game",
        "Play through any position with the engine and live coach notes — no account needed. Full-game reviews are saved to your account.",
        "analyze",
        "Open Analyze",
      ],
    ]);
  }

  // "Get started" checklist; buttons are delegated through data-lib-action.
  function renderOnboardingSteps(steps) {
    const card = document.getElementById("dashboard-steps");
    if (!card) return;
    card.innerHTML =
      `<header class="card-head"><h2>Get started</h2></header>` +
      steps
        .map(
          ([title, detail, action, label], i) =>
            `<div class="step"><span class="step-n" aria-hidden="true">${i + 1}</span>` +
            `<div class="step-text"><b>${escapeHtml(title)}</b><p>${escapeHtml(detail)}</p></div>` +
            `<button type="button" class="btn sm" data-lib-action="${action}">${escapeHtml(label)}</button></div>`,
        )
        .join("");
    card.hidden = false;
  }

  // Either endpoint failing leaves the error card and rethrows, so the caller
  // reports it via setStatusError — "Ready" is only set on a full success.
  async function loadDashboard() {
    const seq = ++loadSeq;
    let payload;
    try {
      payload = await api(`/api/dashboard?local_date=${localDateString()}`);
    } catch (error) {
      if (seq !== loadSeq) return;
      renderLibraryError(error.message);
      throw error;
    }
    if (seq !== loadSeq) return;
    if (payload.streak) appState.dayStreak = payload.streak;
    renderDashboardToday(payload);
    renderSteps(payload);
    try {
      if (!(await fetchDashboardRepertoires(seq))) return;
    } catch (error) {
      if (seq !== loadSeq) return;
      renderLibraryError(error.message);
      throw error;
    }
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
