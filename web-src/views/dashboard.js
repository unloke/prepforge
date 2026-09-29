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

// Library preview mini-board. Same grid/piece contract as the shared Scout
// mini-board renderer (reuse its .scout-miniboard styles), but local to this
// lazy chunk so the eager main bundle never pulls Scout's report machinery in.
function renderMiniBoardHtml(fen, orientation, { parseFenBoard, pieceSvg }) {
  const pieces = parseFenBoard(fen);
  const ranks = orientation === "black" ? [1, 2, 3, 4, 5, 6, 7, 8] : [8, 7, 6, 5, 4, 3, 2, 1];
  const files = orientation === "black" ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const labels = ["a", "b", "c", "d", "e", "f", "g", "h"];
  let html = '<div class="scout-miniboard" aria-hidden="true">';
  for (const rank of ranks) {
    for (const fi of files) {
      const sq = `${labels[fi]}${rank}`;
      const dark = (rank + fi) % 2 === 1;
      const p = pieces[sq];
      html += `<div class="scout-minisquare ${dark ? "dark" : "light"}">${p ? pieceSvg(p) : ""}</div>`;
    }
  }
  return `${html}</div>`;
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
  localDateString,
  goToSmartTraining,
  editRepertoire,
  openRepertoireContextMenu,
  createRepertoirePrompt,
  hydrateBuild,
  showInputModal,
  promptImportRepertoireFromPgn,
  requireSignIn,
  goToView,
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

  function masteryMixSegments(health) {
    const mix = [
      ["mastered", health.mastered, "Mastered"],
      ["learning", health.learning, "Learning"],
      ["due", health.due, "Due"],
      ["weak", health.weak, "Weak"],
      ["new", health.untrained, "New"],
    ];
    return mix.filter(([, n]) => n > 0);
  }

  function renderLibraryPreview(repertoire) {
    const pane = document.getElementById("lib-preview");
    if (!pane) return;
    if (!repertoire) {
      pane.hidden = true;
      pane.innerHTML = "";
      return;
    }
    pane.hidden = false;
    const color = String(repertoire.color || "white");
    const active = repertoire.is_active !== false;
    const dot = document.getElementById("lib-preview-dot");
    if (dot) {
      dot.className = `color-dot ${color}`;
    }
    const nameEl = document.getElementById("lib-preview-name");
    if (nameEl) nameEl.textContent = repertoire.name || "Repertoire";
    const subEl = document.getElementById("lib-preview-sub");
    if (subEl) {
      const bits = [color === "black" ? "Black" : "White"];
      if (!active) bits.push("disabled");
      subEl.textContent = bits.join(" · ");
    }
    const board = document.getElementById("lib-preview-board");
    if (board) {
      const fen = repertoire.root_fen;
      if (fen && previewRenderers) {
        board.innerHTML = renderMiniBoardHtml(fen, color, previewRenderers);
      } else {
        board.innerHTML = '<div class="pv-board-empty muted">Open to load the board</div>';
      }
    }
    const mixEl = document.getElementById("lib-preview-mix");
    const legendEl = document.getElementById("lib-preview-legend");
    const health = repertoire.health;
    const segments = health ? masteryMixSegments(health) : [];
    if (mixEl) {
      mixEl.setAttribute("aria-label", "Mastery mix");
      mixEl.innerHTML = segments.length
        ? segments
            .map(
              ([kind, n]) =>
                `<i class="k-${kind}" style="flex:${n}" title="${kind} ${n}"></i>`,
            )
            .join("")
        : '<span class="muted pv-mix-empty">no moves trained yet</span>';
    }
    if (legendEl) {
      const total = segments.reduce((sum, [, n]) => sum + n, 0);
      legendEl.innerHTML = segments
        .map(
          ([kind, n]) =>
            `<span><i class="k-${kind}"></i>${kind} ${total ? Math.round((n / total) * 100) : 0}%</span>`,
        )
        .join("");
    }
    const openBtn = document.getElementById("lib-preview-open");
    if (openBtn) {
      openBtn.onclick = () => editRepertoire(repertoire.id);
    }
    const trainBtn = document.getElementById("lib-preview-train");
    if (trainBtn) {
      // The smart queue is mixed (due reviews and weak spots across every
      // repertoire), so neither the button copy nor the status may imply a
      // single-repertoire session.
      trainBtn.onclick = () => goToSmartTraining("Starting smart queue…");
    }
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
    el.hidden = !(n > 0);
    el.textContent = String(n);
  }

  // The backend ships personalized next actions on /api/dashboard
  // (payload.recommendations — ordered by account state, see
  // services/dashboard_recommendations.py). Each item is
  // {id, title, detail, cta: {label, view}} and renders with a CTA button that
  // jumps straight to the matching view. Plain strings (legacy payloads) still
  // render as plain bullets. Two placements share this one renderer: the
  // repertoires empty state (first-run guide) and the Today card (priority
  // actions like due review for accounts that already have repertoires).
  function recommendationsHtml(recommendations) {
    const items = (Array.isArray(recommendations) ? recommendations : [])
      .slice(0, 3)
      .map((item) => {
        if (typeof item === "string") {
          return item.trim() ? `<li>${escapeHtml(item.trim())}</li>` : "";
        }
        if (!item || typeof item !== "object" || !item.title) return "";
        const detail = item.detail
          ? `<span class="rec-detail">${escapeHtml(String(item.detail))}</span>`
          : "";
        const cta =
          item.cta && item.cta.view
            ? `<button type="button" class="btn sm rec-cta" ` +
              `data-rec-view="${escapeHtml(String(item.cta.view))}" ` +
              `data-testid="rec-cta-${escapeHtml(String(item.id || "item"))}">` +
              `${escapeHtml(String(item.cta.label || item.cta.view))}</button>`
            : "";
        return (
          `<li class="rec-item"><span class="rec-text">` +
          `<b>${escapeHtml(String(item.title))}</b>${detail}</span>${cta}</li>`
        );
      })
      .join("");
    if (!items) return "";
    return '<ul class="dashboard-next-steps">' + items + "</ul>";
  }

  // CTA buttons route one click to the view the recommendation targets.
  function bindRecommendationCtas(container) {
    if (!container || !container.querySelectorAll) return;
    container.querySelectorAll(".rec-cta").forEach((btn) => {
      btn.addEventListener("click", () => {
        const view = btn.dataset && btn.dataset.recView;
        if (view && goToView) goToView(view);
      });
    });
  }

  function healthBadgeHtml(health) {
    // The list carries a cached health badge (refreshed off Build/train, no per-row tree
    // walk). It is null until the rep is first opened/trained — then just omit the badge.
    if (!health) return "";
    if (!health.trainable) {
      return '<span class="rep-health rep-health-empty">no moves yet</span>';
    }
    const parts = [];
    if (health.weak) {
      parts.push(
        `<span class="rh-weak" title="Missed more than answered">${health.weak} weak</span>`,
      );
    }
    if (health.due) {
      parts.push(`<span class="rh-due" title="Spaced repetition says now">${health.due} due</span>`);
    }
    if (health.untrained) {
      parts.push(
        `<span class="rh-untrained" title="Never trained">${health.untrained} new</span>`,
      );
    }
    const pct = health.mastery_pct || 0;
    const tier = pct >= 80 ? "high" : pct >= 40 ? "mid" : "low";
    return (
      `<span class="rep-health">` +
      `<span class="rh-pct tier-${tier}" title="${health.mastered}/${health.trainable} moves">${pct}% mastered</span>` +
      (parts.length ? `<span class="rh-detail">${parts.join(" · ")}</span>` : "") +
      `</span>`
    );
  }

  function renderDashboardToday(payload) {
    const card = document.getElementById("dashboard-today");
    if (!card) return;
    const streak = payload.streak || { current: 0, best: 0, trained_today: false };
    const due = payload.due_reviews || 0;
    const soon = payload.due_soon || 0;
    // `repertoires` on this payload is a COUNT. Hiding Today when it is 0
    // buried Train now for new accounts. Always show the card once we have a
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
    const best = streak.best > 1 ? ` &middot; best ${streak.best}` : "";
    const queueBits = [];
    if (due > 0) queueBits.push(`<b>${due}</b> due now`);
    if (soon > 0) queueBits.push(`<b>${soon}</b> coming up in 24h`);
    const queueText = queueBits.length ? queueBits.join(" &middot; ") : "Queue is clear";
    // Priority next actions (due review, weak-spot drill, …) for accounts that
    // already have repertoires; the no-repertoire onboarding list lives in the
    // repertoires card's empty state instead, so nothing renders twice.
    const nextStepsHtml =
      (payload.repertoires || 0) > 0 ? recommendationsHtml(payload.recommendations) : "";
    const recap = payload.recap || null;
    let recapHtml = "";
    if (recap && (recap.reviews_7d > 0 || recap.mastered_now > 0 || recap.weak_now > 0)) {
      const delta = (n, goodWhenUp) => {
        if (!n) return "";
        const cls = (n > 0) === goodWhenUp ? "up" : "down";
        return ` <span class="${cls}">(${n > 0 ? "+" : ""}${n})</span>`;
      };
      const bits = [
        `<b>${recap.reviews_7d}</b> review${recap.reviews_7d === 1 ? "" : "s"} this week`,
        `<b>${recap.mastered_now}</b> mastered${delta(recap.mastered_delta, true)}`,
      ];
      if (recap.weak_now > 0 || recap.weak_delta !== 0) {
        bits.push(
          `<b>${recap.weak_now}</b> weak spot${recap.weak_now === 1 ? "" : "s"}${delta(recap.weak_delta, false)}`,
        );
      }
      recapHtml = `<div class="today-recap">${bits.join(" &middot; ")}</div>`;
    }
    card.innerHTML = `
    <div class="today-streak" data-lit="${streak.current > 0 ? "1" : "0"}"
         title="Calendar days with at least one graded move">
      <span class="today-flame" aria-hidden="true">\u{1F525}</span>
      <span class="today-count">${streak.current}</span>
      <span class="today-unit">day streak${best}</span>
    </div>
    <div class="today-text">
      ${warningHtml || `<div class="today-note">${note}</div>`}
      <div class="today-queue">${queueText}</div>
      ${recapHtml}
    </div>
    ${nextStepsHtml}
    <button class="btn primary" id="dashboard-train-now" data-testid="dashboard-train-now">Train</button>
  `;
    card.hidden = false;
    bindRecommendationCtas(card);
    document.getElementById("dashboard-train-now").addEventListener("click", () =>
      goToSmartTraining(due > 0 ? "Starting due review…" : "Starting training…"),
    );
  }

  let lastDashboardRecommendations = [];

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
          <div class="lib-row list-item is-shared" tabindex="0" data-repertoire-id="${escapeHtml(item.id)}" data-shared="1" aria-selected="false">
            <span class="lib-cell-rep">
              <span class="color-dot ${escapeHtml(item.color)}"></span>
              <span class="name">${escapeHtml(item.name)}</span>
              <span class="team-role-badge sm">shared</span>
            </span>
            <span class="lib-cell-mastery"><span class="muted">read-only</span></span>
            <span class="lib-cell-queue"><span class="muted">—</span></span>
            <span class="lib-cell-menu"></span>
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
    renderLibraryPreview(null);
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
          "list-item",
          active ? "" : "is-disabled",
          String(item.id) === selectedRepId ? "is-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        const status = active ? "" : ' <span class="sub">· disabled</span>';
        const team =
          item.visibility === "team" && item.team_id
            ? appState.teams.find((tm) => tm.id === item.team_id)
            : null;
        const shareBadge =
          item.visibility === "team" && item.team_id
            ? ` <span class="team-role-badge sm" title="Shared with ${escapeHtml(team ? team.name : "team")}">shared</span>`
            : "";
        const health = item.health;
        const pct = health ? health.mastery_pct || 0 : null;
        const tier = pct == null ? "" : pct >= 80 ? "high" : pct >= 40 ? "mid" : "low";
        const mastery = pct == null
          ? '<span class="lib-mastery lib-mastery-none">no moves trained yet</span>'
          : `<span class="lib-mastery"><span class="lib-mbar" role="img" aria-label="${pct}% mastered"><i class="tier-${tier}" style="width:${pct}%"></i></span><b>${pct}%</b></span>`;
        const chips = [];
        if (health && health.weak) {
          chips.push(`<span class="kchip k-weak" title="Missed more than answered">${health.weak} weak</span>`);
        }
        if (health && health.due) {
          chips.push(`<span class="kchip k-due" title="Spaced repetition says now">${health.due} due</span>`);
        }
        if (health && health.untrained) {
          chips.push(`<span class="kchip k-new" title="Never trained">${health.untrained} new</span>`);
        }
        const chipsHtml = chips.length
          ? chips.join("")
          : '<span class="muted">—</span>';
        return `
          <div class="${cls}" tabindex="0" data-repertoire-id="${id}" data-active="${active ? "1" : "0"}" aria-selected="${String(item.id) === selectedRepId}">
            <span class="lib-opt" role="option" aria-selected="${String(item.id) === selectedRepId}">
              <span class="lib-cell-rep">
                <span class="color-dot ${color}"></span>
                <span class="name">${name}</span>
                <span class="sub"> · ${color}</span>${status}${shareBadge}
              </span>
              <span class="lib-cell-mastery">${mastery}</span>
              <span class="lib-cell-queue">${chipsHtml}</span>
            </span>
            <button type="button" class="ib row-menu-btn" data-row-menu="${id}" title="Actions (train · rename · share · delete)" aria-haspopup="menu">⋯</button>
          </div>
        `;
      })
      .join("");
    applySelectionHighlight();
    const selected = visible.find((item) => String(item.id) === selectedRepId) || null;
    renderLibraryPreview(selected);
    container.querySelectorAll(".lib-row").forEach((row) => {
      const repId = row.dataset.repertoireId;
      const preview = () => {
        selectedRepId = repId;
        applySelectionHighlight();
        renderLibraryPreview(visible.find((item) => String(item.id) === repId) || null);
      };
      const open = () => editRepertoire(repId);
      row.addEventListener("click", (event) => {
        if (event.target.closest(".row-menu-btn")) return;
        preview();
      });
      row.addEventListener("dblclick", (event) => {
        if (event.target.closest(".row-menu-btn")) return;
        open();
      });
      row.addEventListener("keydown", (event) => {
        if (event.target !== row) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          // Enter on the selected row opens the workspace (prototype's
          // double-click); space previews.
          if (event.key === "Enter" && selectedRepId === repId) open();
          else preview();
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

  function renderRepertoireList() {
    const container = document.getElementById("dashboard-repertoires");
    if (!container) return;
    const useSharedFallback =
      !repListCache.own.length && repListCache.shared.length > 0;
    const universe = useSharedFallback ? repListCache.shared : repListCache.own;
    // Selection follows the visible list: narrowing the table moves the
    // selection to the first shown row when the old one is filtered out — the
    // same rule the unfiltered table always had for a disappearing row.
    const shown = filterLibraryRows(universe, {
      filter: libraryFilter,
      query: libraryQuery,
    });
    if (!universe.length) {
      setListboxRole(container, false);
      const nextSteps = recommendationsHtml(lastDashboardRecommendations);
      container.innerHTML =
        '<div class="empty-state">No repertoires yet.</div>' +
        nextSteps;
      bindRecommendationCtas(container);
      renderLibraryPreview(null);
      selectedRepId = null;
      return;
    }
    if (!shown.length) {
      // Non-empty list narrowed to nothing by the filter/search.
      setListboxRole(container, false);
      container.innerHTML =
        '<div class="empty-state">No repertoires match this filter.</div>';
      renderLibraryPreview(null);
      selectedRepId = null;
      return;
    }
    setListboxRole(container, true);
    if (useSharedFallback) {
      renderSharedFallbackRows(container, shown);
      return;
    }
    renderOwnRepertoireRows(container, shown);
  }

  // role=option rows need a real listbox owner; empty states drop the role.
  function setListboxRole(container, on) {
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

  async function loadDashboardRepertoires() {
    try {
      if (appState.signedIn && !appState.teams.length) {
        try {
          const teamsPayload = await api("/api/teams");
          appState.teams = teamsPayload.teams || [];
        } catch (_) {
          /* team names for share badges are optional */
        }
      }
      const payload = await api("/api/repertoires");
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
      renderRepertoireList();
    } catch (error) {
      const container = document.getElementById("dashboard-repertoires");
      if (!container) return;
      setListboxRole(container, false);
      container.innerHTML = `<div class="empty-state">${escapeHtml(error.message)}</div>`;
    }
  }

  async function loadDashboard() {
    const payload = await api(`/api/dashboard?local_date=${localDateString()}`);
    if (payload.streak) appState.dayStreak = payload.streak;
    lastDashboardRecommendations = Array.isArray(payload.recommendations)
      ? payload.recommendations
      : [];
    renderDashboardToday(payload);
    const due = payload.due_reviews || 0;
    const metrics = [
      ["Games", payload.games, ""],
      ["Repertoires", payload.repertoires, ""],
      ["Sessions", payload.training_sessions, ""],
      ["Due review", due, due > 0 ? "is-due is-clickable" : ""],
    ];
    document.getElementById("dashboard-metrics").innerHTML = metrics
      .map(
        ([label, value, cls]) => `
        <${cls.includes("is-due") ? "button type=\"button\"" : "div"} class="metric ${cls}" ${cls.includes("is-due") ? 'data-action="due-review"' : ""}>
          <div class="metric-value">${value}</div>
          <div class="metric-label">${label}</div>
        </${cls.includes("is-due") ? "button" : "div"}>
      `,
      )
      .join("");
    const dueMetric = document.querySelector('#dashboard-metrics [data-action="due-review"]');
    if (dueMetric) {
      dueMetric.addEventListener("click", () =>
        goToSmartTraining("Starting due review…"),
      );
    }
    await loadDashboardRepertoires();
    setStatus("Ready");
  }

  async function dashboardImportPgn() {
    if (!requireSignIn("Sign in (or create an account) to import a repertoire")) return;
    const input = document.getElementById("dashboard-import-input");
    input.value = "";
    input.click();
  }

  async function handleImportPgnFile(file) {
    if (!requireSignIn("Sign in (or create an account) to import a repertoire")) return;
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

    const newRepBtn = document.getElementById("dashboard-new-rep");
    if (newRepBtn) {
      newRepBtn.addEventListener("click", () =>
        createRepertoirePrompt({ title: "New repertoire" }),
      );
    }

    const importBtn = document.getElementById("dashboard-import-pgn");
    if (importBtn) {
      importBtn.addEventListener("click", () => dashboardImportPgn().catch(() => {}));
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
    healthBadgeHtml,
    setLibraryFilter,
    setLibraryQuery,
  };
}
